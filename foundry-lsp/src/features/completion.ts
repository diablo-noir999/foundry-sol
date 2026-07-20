import {
  CompletionItem,
  CompletionItemKind,
  InsertTextFormat,
  Position,
  TextEdit,
  MarkupKind,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import {
  AstNode,
  ContractDefinition,
  FunctionDefinition,
  StateVariableDeclaration,
  VariableDeclaration,
  isContractDefinition,
  isFunctionDefinition,
  isStateVariableDeclaration,
  isStructDefinition,
  isEnumDefinition,
  isEventDefinition,
  isErrorDefinition,
  isModifierDefinition,
  isImportDirective,
  isVariableDeclaration,
  Identifier,
  isIdentifier,
} from '../ast/types';
import { CompileResult } from '../compiler/cache';
import { FoundryProject } from '../project';
import { parseSrc, walkAst, positionToOffset } from '../ast/traversal';
import { extractNatSpec, extractTypeName } from '../utils';

const SOLIDITY_KEYWORDS: [string, string][] = [
  ['pragma', 'pragma solidity ^0.8.0;'],
  ['contract', 'contract ${1:Name} {\n\t$0\n}'],
  ['interface', 'interface ${1:Name} {\n\t$0\n}'],
  ['library', 'library ${1:Name} {\n\t$0\n}'],
  ['function', 'function ${1:name}(${2:params}) ${3|public,external,internal,private|} {\n\t$0\n}'],
  ['struct', 'struct ${1:Name} {\n\t${2:type} ${3:name};\n\t$0\n}'],
  ['enum', 'enum ${1:Name} {\n\t${2:VALUE1},\n\t$0\n}'],
  ['event', 'event ${1:Name}(${2:params});'],
  ['error', 'error ${1:Name}(${2:params});'],
  ['modifier', 'modifier ${1:name}(${2:params}) {\n\t$0\n\t_;\n}'],
  ['mapping', 'mapping(${1:keyType} => ${2:valueType}) ${3:name}'],
  ['import', 'import "${1:path}";'],
  ['using', 'using ${1:Library} for ${2:type};'],
  ['emit', 'emit ${1:EventName}(${2:args});'],
  ['if', 'if (${1:condition}) {\n\t$0\n}'],
  ['else', 'else {\n\t$0\n}'],
  ['for', 'for (${1:uint i = 0; i < ${2:limit}; i++}) {\n\t$0\n}'],
  ['while', 'while (${1:condition}) {\n\t$0\n}'],
  ['do', 'do {\n\t$0\n} while (${1:condition});'],
  ['return', 'return ${1:value};'],
  ['returns', 'returns (${1:bool})'],
  ['try', 'try ${1:expression}() {\n\t$0\n} catch {\n\t\n}'],
  ['catch', 'catch (${1:error}) {\n\t$0\n}'],
  ['delete', 'delete ${1:variable};'],
  ['new', 'new ${1:Contract}(${2:args})'],
  ['assembly', 'assembly {\n\t$0\n}'],
  ['unchecked', 'unchecked {\n\t$0\n}'],
  ['true', 'true'],
  ['false', 'false'],
  ['public', 'public'],
  ['private', 'private'],
  ['internal', 'internal'],
  ['external', 'external'],
  ['pure', 'pure'],
  ['view', 'view'],
  ['payable', 'payable'],
  ['virtual', 'virtual'],
  ['override', 'override'],
  ['abstract', 'abstract'],
  ['immutable', 'immutable'],
  ['constant', 'constant'],
  ['memory', 'memory'],
  ['storage', 'storage'],
  ['calldata', 'calldata'],
  ['transient', 'transient'],
  ['anonymous', 'anonymous'],
  ['indexed', 'indexed ${1:param}'],
  ['nonpayable', 'nonpayable'],
];

const GLOBAL_FUNCTIONS: [string, string, string][] = [
  ['assert', 'assert(${1:condition})', 'Aborts execution with panic error'],
  ['require', 'require(${1:condition}, "${2:message}")', 'Aborts execution with error message'],
  ['revert', 'revert("${1:message}")', 'Aborts execution with revert error'],
  ['keccak256', 'keccak256(${1:data})', 'Keccak-256 hash function'],
  ['sha256', 'sha256(${1:data})', 'SHA-256 hash function'],
  ['ripemd160', 'ripemd160(${1:data})', 'RIPEMD-160 hash function'],
  ['ecrecover', 'ecrecover(${1:hash}, ${2:v}, ${3:r}, ${4:s})', 'Elliptic curve signature recovery'],
  ['addmod', 'addmod(${1:x}, ${2:y}, ${3:k})', 'Modular addition'],
  ['mulmod', 'mulmod(${1:x}, ${2:y}, ${3:k})', 'Modular multiplication'],
  ['gasleft', 'gasleft()', 'Remaining gas'],
  ['blockhash', 'blockhash(${1:blockNumber})', 'Hash of the given block'],
  ['selfdestruct', 'selfdestruct(${1:addr})', 'Destroy contract and send funds'],
  ['abi.encode', 'abi.encode(${1:args})', ' ABI-encode the given arguments'],
  ['abi.encodePacked', 'abi.encodePacked(${1:args})', 'Tightly packed ABI-encode'],
  ['abi.encodeWithSelector', 'abi.encodeWithSelector(${1:selector}, ${2:args})', 'ABI-encode with function selector'],
  ['abi.encodeWithSignature', 'abi.encodeWithSignature("${1:signature}", ${2:args})', 'ABI-encode with signature string'],
  ['abi.decode', 'abi.decode(${1:data}, (${2:Type}))', 'ABI-decode the given data'],
];

const GLOBAL_VARIABLES: [string, string, string, string][] = [
  ['msg.sender', 'msg.sender', 'address', 'Sender of the current call'],
  ['msg.value', 'msg.value', 'uint', 'Value (in wei) sent with the call'],
  ['msg.data', 'msg.data', 'bytes', 'Complete calldata'],
  ['msg.sig', 'msg.sig', 'bytes4', 'First four bytes of calldata'],
  ['msg.gas', 'msg.gas', 'uint', 'Remaining gas (alias for gasleft())'],
  ['block.number', 'block.number', 'uint', 'Current block number'],
  ['block.timestamp', 'block.timestamp', 'uint', 'Current block timestamp'],
  ['block.prevrandao', 'block.prevrandao', 'uint', 'Previous block prevrandao value'],
  ['block.basefee', 'block.basefee', 'uint', 'Current block basefee'],
  ['block.chainid', 'block.chainid', 'uint', 'Current chain id'],
  ['block.coinbase', 'block.coinbase', 'address', 'Current block miner address'],
  ['block.gaslimit', 'block.gaslimit', 'uint', 'Current block gas limit'],
  ['tx.origin', 'tx.origin', 'address', 'Original caller of the call chain'],
  ['tx.gasprice', 'tx.gasprice', 'uint', 'Gas price of the transaction'],
  ['now', 'now', 'uint', 'Current block timestamp (alias for block.timestamp)'],
];

const ETHER_UNITS: [string, string][] = [
  ['1 wei', 'wei unit (1)'],
  ['1 gwei', 'gwei unit (1e9 wei)'],
  ['1 ether', 'ether unit (1e18 wei)'],
  ['1 finney', 'finney unit (1e15 wei) [deprecated]'],
  ['1 szabo', 'szabo unit (1e12 wei) [deprecated]'],
];

const TIME_UNITS: [string, string][] = [
  ['1 seconds', 'seconds unit'],
  ['1 minutes', 'minutes unit (60 seconds)'],
  ['1 hours', 'hours unit (3600 seconds)'],
  ['1 days', 'days unit (86400 seconds)'],
  ['1 weeks', 'weeks unit (604800 seconds)'],
  ['1 years', 'years unit (31536000 seconds) [deprecated]'],
];

const ELEMENTARY_TYPES: [string, string][] = [
  ['address', 'Address type (20 bytes)'],
  ['bool', 'Boolean type'],
  ['string', 'Dynamic byte array string'],
  ['bytes', 'Dynamic byte array'],
  ['uint', 'Unsigned integer (alias for uint256)'],
  ['uint256', 'Unsigned integer (256 bits)'],
  ['uint128', 'Unsigned integer (128 bits)'],
  ['uint64', 'Unsigned integer (64 bits)'],
  ['uint32', 'Unsigned integer (32 bits)'],
  ['uint16', 'Unsigned integer (16 bits)'],
  ['uint8', 'Unsigned integer (8 bits)'],
  ['int', 'Signed integer (alias for int256)'],
  ['int256', 'Signed integer (256 bits)'],
  ['int128', 'Signed integer (128 bits)'],
  ['int64', 'Signed integer (64 bits)'],
  ['int32', 'Signed integer (32 bits)'],
  ['int16', 'Signed integer (16 bits)'],
  ['int8', 'Signed integer (8 bits)'],
  ['bytes4', 'Fixed-size byte array (4 bytes)'],
  ['bytes8', 'Fixed-size byte array (8 bytes)'],
  ['bytes16', 'Fixed-size byte array (16 bytes)'],
  ['bytes20', 'Fixed-size byte array (20 bytes)'],
  ['bytes32', 'Fixed-size byte array (32 bytes)'],
  ['uint96', 'Unsigned integer (96 bits)'],
  ['uint112', 'Unsigned integer (112 bits)'],
  ['uint160', 'Unsigned integer (160 bits)'],
  ['int96', 'Signed integer (96 bits)'],
  ['int112', 'Signed integer (112 bits)'],
  ['int160', 'Signed integer (160 bits)'],
];

const GLOBAL_OBJECT_MEMBERS: Record<string, [string, string, string][]> = {
  msg: [
    ['data', 'bytes', 'Complete calldata'],
    ['sender', 'address', 'Sender of the current call'],
    ['sig', 'bytes4', 'First four bytes of calldata'],
    ['value', 'uint', 'Value (in wei) sent with the call'],
    ['gas', 'uint', 'Remaining gas (alias for gasleft())'],
  ],
  block: [
    ['chainid', 'uint', 'Current chain id'],
    ['coinbase', 'address', 'Current block miner/validator address'],
    ['difficulty', 'uint', 'Current block difficulty (deprecated after Paris)'],
    ['gaslimit', 'uint', 'Current block gas limit'],
    ['number', 'uint', 'Current block number'],
    ['prevrandao', 'uint', 'Previous block prevrandao value'],
    ['timestamp', 'uint', 'Current block timestamp (unix seconds)'],
    ['basefee', 'uint', 'Current block basefee'],
    ['blobbasefee', 'uint', 'Current block blob basefee'],
    ['blobhashes', 'bytes32[]', 'Current block blob hashes'],
  ],
  tx: [
    ['gasprice', 'uint', 'Gas price of the transaction'],
    ['origin', 'address', 'Original caller of the call chain'],
  ],
  abi: [
    ['encode', 'abi.encode(${1:args})', 'ABI-encode the given arguments'],
    ['encodePacked', 'abi.encodePacked(${1:args})', 'Tightly packed ABI-encode'],
    ['encodeWithSelector', 'abi.encodeWithSelector(${1:selector}, ${2:args})', 'ABI-encode with function selector'],
    ['encodeWithSignature', 'abi.encodeWithSignature("${1:signature}", ${2:args})', 'ABI-encode with signature string'],
    ['encodeCall', 'abi.encodeCall(${1:functionPointer}, (${2:args}))', 'ABI-encode a call to a function pointer'],
    ['decode', 'abi.decode(${1:data}, (${2:Type}))', 'ABI-decode the given data'],
  ],
};

const ADDRESS_MEMBERS: [string, string, string, string][] = [
  ['balance', 'balance', 'uint', 'Address balance in wei'],
  ['code', 'code', 'bytes', 'Code at the address'],
  ['codehash', 'codehash', 'bytes32', 'Keccak-256 hash of the code'],
  ['call', 'call(${1:bytes memory data})', 'bool', 'Call the address with arbitrary data'],
  ['delegatecall', 'delegatecall(${1:bytes memory data})', 'bool', 'Delegatecall to the address'],
  ['staticcall', 'staticcall(${1:bytes memory data})', 'bool', 'Staticcall to the address'],
  ['transfer', 'transfer(${1:uint256 amount})', 'bool', 'Send wei to the address'],
  ['send', 'send(${1:uint256 amount})', 'bool', 'Send wei to the address (returns false on failure)'],
];

// ─── Dir cache for import completions (2s TTL) ───
const dirCache = new Map<string, { entries: fs.Dirent[]; timestamp: number }>();
const DIR_CACHE_TTL = 2000;

async function readdirCached(dir: string): Promise<fs.Dirent[]> {
  const now = Date.now();
  const cached = dirCache.get(dir);
  if (cached && now - cached.timestamp < DIR_CACHE_TTL) {
    return cached.entries;
  }
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    dirCache.set(dir, { entries, timestamp: now });
    return entries;
  } catch {
    return [];
  }
}

export async function provideCompletion(
  ast: AstNode,
  document: TextDocument,
  position: Position,
  _compileResult: CompileResult,
  project: FoundryProject | undefined
): Promise<CompletionItem[]> {
  const content = document.getText();
  const fullLine = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: position.character + 50 },
  });
  const lineText = document.getText({
    start: { line: position.line, character: 0 },
    end: position,
  });

  // Extract prefix
  let prefix = '';
  for (let i = lineText.length - 1; i >= 0; i--) {
    const ch = lineText[i];
    if (/[a-zA-Z0-9_]/.test(ch)) {
      prefix = ch + prefix;
    } else {
      break;
    }
  }

  // 1. Import path completion
  const importMatch = fullLine.match(/import\s+"([^"]*)$/);
  if (importMatch) {
    return await provideImportCompletion(importMatch[1], position, project);
  }

  // 2. Emit trigger — list events
  if (/\bemit\s+\w*$/.test(lineText)) {
    return provideEmitCompletion(ast, content);
  }

  // 3. Revert trigger — list custom errors
  if (/\brevert\s+\w*$/.test(lineText)) {
    return provideRevertCompletion(ast, content);
  }

  // 4. Dot member access (supports chaining)
  const dotMatch = lineText.match(/([\w.]+)\.\s*$/);
  if (dotMatch) {
    return provideDotCompletion(dotMatch[1], ast, content, position, project);
  }

  // 11.3: NatSpec tag completion
  if (/^\s*\/\/\//.test(fullLine) || /^\s*\*/.test(fullLine)) {
    return provideNatSpecCompletion(ast, position, content);
  }

  // 11.4: `using` library completions
  if (/\busing\s+\w*$/.test(lineText)) {
    return provideUsingLibraryCompletion(ast, content, prefix);
  }

  const items: CompletionItem[] = [];

  // 5. Global functions
  for (const [name, snippet, desc] of GLOBAL_FUNCTIONS) {
    if (prefix && !name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    items.push({
      label: name,
      kind: CompletionItemKind.Function,
      insertText: snippet,
      insertTextFormat: InsertTextFormat.Snippet,
      detail: desc,
      documentation: { kind: MarkupKind.Markdown, value: desc },
    });
  }

  // 6. Global variables (as properties on msg, block, tx)
  for (const [name, insertText, type, desc] of GLOBAL_VARIABLES) {
    if (prefix && !name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    items.push({
      label: name,
      kind: CompletionItemKind.Variable,
      insertText,
      detail: `${type} — ${desc}`,
    });
  }

  // 7. Ether units
  for (const [unit, desc] of ETHER_UNITS) {
    items.push({
      label: unit,
      kind: CompletionItemKind.Unit,
      detail: desc,
    });
  }

  // 8. Time units
  for (const [unit, desc] of TIME_UNITS) {
    items.push({
      label: unit,
      kind: CompletionItemKind.Unit,
      detail: desc,
    });
  }

  // 8.5. Elementary types
  for (const [typeName, desc] of ELEMENTARY_TYPES) {
    if (prefix && !typeName.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    items.push({
      label: typeName,
      kind: CompletionItemKind.TypeParameter,
      detail: desc,
    });
  }

  // 9. Keywords
  for (const [keyword, snippet] of SOLIDITY_KEYWORDS) {
    if (prefix && !keyword.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    items.push({
      label: keyword,
      kind: CompletionItemKind.Keyword,
      insertText: snippet,
      insertTextFormat: InsertTextFormat.Snippet,
      detail: 'Solidity keyword',
    });
  }

  // 10. Local variable scope resolution (function params, local vars, for-loop vars)
  const offset = positionToOffset(content, position);
  const scopedVars = findVariableDeclarationsInScope(ast, offset, content);
  const scopedNames = new Set<string>();
  for (const v of scopedVars) {
    if (scopedNames.has(v.name)) continue;
    scopedNames.add(v.name);
    if (prefix && !v.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    items.push({
      label: v.name,
      kind: CompletionItemKind.Variable,
      detail: `${v.typeName} ${v.name}`,
      documentation: {
        kind: MarkupKind.Markdown,
        value: v.blockOffset === 0
          ? `*(parameter)* ${v.typeName} ${v.name}`
          : `*(local variable)* ${v.typeName} ${v.name}`,
      },
    });
  }

  // 10.5. AST identifiers (contracts, structs, enums, etc.)
  const idItems = collectIdentifiers(ast, content, prefix);
  items.push(...idItems);

  // Sort: prefix matches first, then by usage frequency, then kind, then alphabetical
  // Lower rank = appears first in results
  const USAGE_RANK: Record<string, number> = {
    // Most common Solidity patterns
    'function': 1, 'struct': 2, 'mapping': 3, 'event': 4, 'modifier': 5,
    'enum': 6, 'error': 7, 'constructor': 8, 'fallback': 9, 'receive': 10,
    // Types (high frequency)
    'uint256': 11, 'uint': 12, 'address': 13, 'bool': 14, 'string': 15,
    'bytes32': 16, 'bytes': 17, 'int256': 18, 'int': 19, 'bytes4': 20,
    // Common keywords
    'returns': 21, 'return': 22, 'if': 23, 'else': 24, 'for': 25,
    'while': 26, 'emit': 27, 'require': 28, 'revert': 29, 'assert': 30,
    // Visibility/modifiers
    'public': 31, 'external': 32, 'internal': 33, 'private': 34,
    'view': 35, 'pure': 36, 'payable': 37, 'nonpayable': 38,
    'virtual': 39, 'override': 40, 'abstract': 41,
    // Data location
    'memory': 42, 'storage': 43, 'calldata': 44, 'transient': 45,
    // Declarations
    'contract': 46, 'interface': 47, 'library': 48, 'import': 49,
    'using': 50, 'pragma': 51,
    // Other
    'constant': 52, 'immutable': 53, 'indexed': 54, 'anonymous': 55,
    'assembly': 56, 'unchecked': 57, 'try': 58, 'catch': 59, 'delete': 60, 'new': 61,
    'true': 62, 'false': 63,
  };

  items.sort((a, b) => {
    const aLabel = a.label.toLowerCase();
    const bLabel = b.label.toLowerCase();
    const pfx = prefix?.toLowerCase() ?? '';

    // 1. Exact prefix match first
    const aStarts = aLabel.startsWith(pfx) ? 0 : 1;
    const bStarts = bLabel.startsWith(pfx) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;

    // 2. Usage frequency (lower rank = higher priority)
    const aRank = USAGE_RANK[aLabel] ?? 100;
    const bRank = USAGE_RANK[bLabel] ?? 100;
    if (aRank !== bRank) return aRank - bRank;

    // 3. Kind priority
    const kindPriority: Record<number, number> = {
      [CompletionItemKind.Variable]: 1,
      [CompletionItemKind.Function]: 2,
      [CompletionItemKind.Keyword]: 3,
      [CompletionItemKind.TypeParameter]: 4,
      [CompletionItemKind.Module]: 5,
      [CompletionItemKind.Unit]: 6,
    };
    const aPriority = kindPriority[a.kind ?? 0] ?? 10;
    const bPriority = kindPriority[b.kind ?? 0] ?? 10;
    if (aPriority !== bPriority) return aPriority - bPriority;

    // 4. Alphabetical fallback
    return aLabel.localeCompare(bLabel);
  });

  return items;
}

function provideEmitCompletion(ast: AstNode, content: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  collectEvents(ast, items, seen);
  return items;
}

function provideRevertCompletion(ast: AstNode, content: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  collectErrors(ast, items, seen);
  return items;
}

function collectEvents(
  node: AstNode,
  items: CompletionItem[],
  seen: Set<string>
): void {
  if (isEventDefinition(node) && node.name && !seen.has(node.name)) {
    seen.add(node.name);
    const params =
      (node as any).parameters?.parameters
        ?.map((p: any) => {
          const typeName = extractTypeName(p.typeName as AstNode);
          return `${typeName} ${p.name}`;
        })
        .join(', ') ?? '';
    items.push({
      label: node.name,
      kind: CompletionItemKind.Event,
      detail: `event ${node.name}(${params})`,
      insertText: `${node.name}(${(node as any).parameters?.parameters?.map((_: any, i: number) => `$${i + 1}`).join(', ') ?? ''})`,
      insertTextFormat: InsertTextFormat.Snippet,
    });
  }
  if (node.nodes) {
    for (const child of node.nodes) {
      collectEvents(child, items, seen);
    }
  }
}

function collectErrors(
  node: AstNode,
  items: CompletionItem[],
  seen: Set<string>
): void {
  if (isErrorDefinition(node) && node.name && !seen.has(node.name)) {
    seen.add(node.name);
    const params =
      (node as any).parameters?.parameters
        ?.map((p: any) => {
          const typeName = extractTypeName(p.typeName as AstNode);
          return `${typeName} ${p.name}`;
        })
        .join(', ') ?? '';
    items.push({
      label: node.name,
      kind: CompletionItemKind.Enum,
      detail: `error ${node.name}(${params})`,
      insertText: `${node.name}(${(node as any).parameters?.parameters?.map((_: any, i: number) => `$${i + 1}`).join(', ') ?? ''})`,
      insertTextFormat: InsertTextFormat.Snippet,
    });
  }
  if (node.nodes) {
    for (const child of node.nodes) {
      collectErrors(child, items, seen);
    }
  }
}

function provideDotCompletion(
  expression: string,
  ast: AstNode,
  content: string,
  position: Position,
  project: FoundryProject | undefined
): CompletionItem[] {
  const parts = expression.split('.');
  const rootName = parts[0];

  // 11.1: `this.` — resolve to current contract's members (including inherited)
  if (rootName === 'this') {
    const enclosingContract = findEnclosingContract(ast, position, content);
    if (enclosingContract && isContractDefinition(enclosingContract)) {
      return collectContractMembers(enclosingContract, ast, {
        includeOwn: true,
        includeOwnPrivate: true,
      });
    }
  }

  // 11.2: `super.` — resolve to parent contracts' non-private members (full chain)
  if (rootName === 'super') {
    const enclosingContract = findEnclosingContract(ast, position, content);
    if (enclosingContract && isContractDefinition(enclosingContract)) {
      // Walk direct base contracts and their full inheritance chains
      const items: CompletionItem[] = [];
      const seen = new Set<string>();
      const visited = new Set<number>();
      const baseContracts = (enclosingContract as any).baseContracts ?? [];
      for (const base of baseContracts) {
        const baseName = base.baseName?.name;
        if (!baseName) continue;
        const baseType = findTypeByName(ast, baseName);
        if (baseType && isContractDefinition(baseType)) {
          collectContractMembersInto(baseType, ast, items, seen, visited, {
            includeOwn: true,
            includeOwnPrivate: false,
          });
        }
      }
      return items;
    }
  }

  // 11.3: Global object sub-properties (msg., block., tx., abi.)
  if (parts.length >= 1 && parts.length <= 2 && GLOBAL_OBJECT_MEMBERS[rootName]) {
    const members = GLOBAL_OBJECT_MEMBERS[rootName];
    return members.map(([name, insertTextOrType, desc]) => {
      // abi members use snippet format, others use type
      if (rootName === 'abi') {
        return {
          label: name,
          kind: CompletionItemKind.Function,
          insertText: insertTextOrType,
          insertTextFormat: InsertTextFormat.Snippet,
          detail: desc,
        };
      }
      return {
        label: name,
        kind: CompletionItemKind.Property,
        detail: `${insertTextOrType} — ${desc}`,
      };
    });
  }

  // 11.4: `msg.sender.` / `address variable.` — address members
  let currentType = resolveTypeFromName(ast, rootName, content);

  // Walk through chained access
  for (let i = 1; i < parts.length && currentType; i++) {
    currentType = resolveTypeFromMember(ast, currentType, parts[i], content);
  }

  // Check if the resolved type is address
  if (currentType === 'address' || currentType === 'address payable') {
    return ADDRESS_MEMBERS.map(([name, insertText, type, desc]) => ({
      label: name,
      kind: CompletionItemKind.Function,
      insertText,
      insertTextFormat: InsertTextFormat.Snippet,
      detail: `${type} — ${desc}`,
    }));
  }

  if (!currentType) return [];

  // Get members of the resolved type
  return getMembersOfType(currentType, ast, content);
}

function resolveTypeFromName(ast: AstNode, name: string, content: string): string | null {
  // Check state variables
  let found: string | null = null;
  walkAst(ast, (node) => {
    if (found) return false;
    if (isStateVariableDeclaration(node) && node.name === name) {
      found = extractTypeName((node as StateVariableDeclaration).typeName as AstNode);
      return false;
    }
    if (isFunctionDefinition(node) && node.name === name) {
      const retParams = (node as FunctionDefinition).returnParameters?.parameters;
      if (retParams && retParams.length > 0) {
        found = extractTypeName(retParams[0].typeName as AstNode);
      }
      return false;
    }
    return true;
  });
  return found;
}

function resolveTypeFromMember(ast: AstNode, typeName: string, memberName: string, content: string): string | null {
  const typeDef = findTypeByName(ast, typeName);
  if (!typeDef) return null;

  if (isContractDefinition(typeDef)) {
    // Walk the full inheritance chain to find the member
    return resolveContractMemberType(typeDef, ast, memberName);
  }

  if (isStructDefinition(typeDef)) {
    const members = (typeDef as any).members ?? [];
    for (const member of members) {
      if (member.name === memberName) {
        return extractTypeName(member.typeName as AstNode);
      }
    }
  }

  return null;
}

function getMembersOfType(typeName: string, ast: AstNode, content: string): CompletionItem[] {
  const items: CompletionItem[] = [];
  const typeDef = findTypeByName(ast, typeName);

  if (typeDef && isContractDefinition(typeDef)) {
    // Walk full inheritance chain — private members from parent contracts excluded,
    // but private members from the contract itself are included (accessible within same source unit)
    return collectContractMembers(typeDef, ast, {
      includeOwn: true,
      includeOwnPrivate: true,
    });
  }

  if (typeDef && isStructDefinition(typeDef)) {
    const members = (typeDef as any).members ?? [];
    for (const member of members) {
      items.push({
        label: member.name,
        kind: CompletionItemKind.Field,
        detail: extractTypeName(member.typeName as AstNode),
      });
    }
  }

  // 11.7: Enum member completion
  if (typeDef && isEnumDefinition(typeDef)) {
    const values = (typeDef as any).values ?? [];
    for (const val of values) {
      items.push({
        label: val.name,
        kind: CompletionItemKind.EnumMember,
        detail: `enum value`,
      });
    }
  }

  // Array methods
  if (typeName.endsWith('[]') || typeName.includes('mapping')) {
    items.push(
      { label: 'push', kind: CompletionItemKind.Function, detail: 'Push element to array' },
      { label: 'pop', kind: CompletionItemKind.Function, detail: 'Remove last element' },
      { label: 'length', kind: CompletionItemKind.Property, detail: 'uint — Array length' },
    );
  }

  return items;
}

function provideUsingLibraryCompletion(
  ast: AstNode,
  content: string,
  prefix: string
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  // Collect all library definitions from the AST
  walkAst(ast, (node) => {
    if (node.nodeType === 'LibraryDefinition' && node.name && !seen.has(node.name)) {
      seen.add(node.name);
      items.push({
        label: node.name,
        kind: CompletionItemKind.Module,
        detail: 'library',
      });
    }
    return true;
  });

  // Also suggest common OpenZeppelin libraries
  const commonLibraries = [
    'SafeERC20', 'SafeCast', 'Counters', 'Address', 'Math', 'Strings',
    'ECDSA', 'MerkleProof', 'ReentrancyGuard', 'Pausable', 'Ownable',
    'AccessControl', 'ERC1967Proxy', 'Clones', 'Create2',
  ];

  for (const lib of commonLibraries) {
    if (!seen.has(lib) && (!prefix || lib.toLowerCase().startsWith(prefix.toLowerCase()))) {
      items.push({
        label: lib,
        kind: CompletionItemKind.Module,
        detail: 'OpenZeppelin library',
      });
    }
  }

  return items;
}

async function provideImportCompletion(
  partial: string,
  position: Position,
  project: FoundryProject | undefined
): Promise<CompletionItem[]> {
  if (!project) return [];

  const items: CompletionItem[] = [];
  const dir = partial.includes('/') ? path.dirname(partial) : '';
  const prefix = partial.includes('/') ? path.basename(partial) : partial;

  const searchDirs = [
    path.join(project.root, project.config.src),
    ...project.config.libs.map((lib) => path.join(project.root, lib)),
  ];

  for (const searchDir of searchDirs) {
    const targetDir = dir ? path.join(searchDir, dir) : searchDir;
    const entries = await readdirCached(targetDir);
    if (entries.length === 0) continue;

    for (const entry of entries) {
      if (!entry.name.endsWith('.sol')) continue;
      if (prefix && !entry.name.startsWith(prefix)) continue;

      const filePath = dir ? `${dir}/${entry.name}` : entry.name;
      items.push({
        label: entry.name,
        kind: CompletionItemKind.File,
        detail: filePath,
        textEdit: TextEdit.replace(
          {
            start: { line: position.line, character: position.character - partial.length },
            end: position,
          },
          filePath
        ),
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (['node_modules', '.git', 'out', 'cache'].includes(entry.name)) continue;
      if (prefix && !entry.name.startsWith(prefix)) continue;

      const dirPath = dir ? `${dir}/${entry.name}` : entry.name;
      items.push({
        label: entry.name + '/',
        kind: CompletionItemKind.Folder,
        detail: dirPath,
        textEdit: TextEdit.replace(
          {
            start: { line: position.line, character: position.character - partial.length },
            end: position,
          },
          dirPath + '/'
        ),
      });
    }
  }

  return items;
}

function collectIdentifiers(
  ast: AstNode,
  content: string,
  prefix: string
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  walkAst(ast, (node) => {
    if (node.name && node.name.startsWith(prefix) && !seen.has(node.name)) {
      seen.add(node.name);

      let kind: CompletionItemKind = CompletionItemKind.Variable;
      if (isContractDefinition(node)) kind = CompletionItemKind.Class;
      else if (isFunctionDefinition(node)) kind = CompletionItemKind.Function;
      else if (isStateVariableDeclaration(node)) kind = CompletionItemKind.Property;
      else if (isStructDefinition(node)) kind = CompletionItemKind.Struct;
      else if (isEnumDefinition(node)) kind = CompletionItemKind.Enum;
      else if (isEventDefinition(node)) kind = CompletionItemKind.Event;
      else if (isErrorDefinition(node)) kind = CompletionItemKind.Enum;
      else if (isModifierDefinition(node)) kind = CompletionItemKind.Function;

      items.push({
        label: node.name,
        kind,
        detail: node.nodeType,
      });
    }
    return true;
  });

  return items;
}

function findTypeByName(ast: AstNode, name: string): AstNode | null {
  let found: AstNode | null = null;

  walkAst(ast, (node) => {
    if (found) return false;
    if (
      node.name === name &&
      (isContractDefinition(node) || isStructDefinition(node) || isEnumDefinition(node))
    ) {
      found = node;
      return false;
    }
    return true;
  });

  return found;
}

/**
 * Collect all visible members from a contract's full inheritance chain.
 * Respects Solidity visibility rules:
 *  - private members: only visible from the defining contract (never inherited)
 *  - internal / public / external: inherited and visible
 *
 * Circular inheritance is handled via a visited set keyed on contract id.
 *
 * @param contract        The contract whose members to collect
 * @param ast             Full AST root (needed to resolve base contract names)
 * @param includeOwn      Whether to include the contract's own members (default true)
 * @param includeOwnPrivate  Whether to include private members from the contract itself
 *                           (useful for this. and external instance access where we are
 *                           conceptually inside the contract; default false)
 */
function collectContractMembers(
  contract: ContractDefinition,
  ast: AstNode,
  opts: { includeOwn?: boolean; includeOwnPrivate?: boolean } = {}
): CompletionItem[] {
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  const visited = new Set<number>();

  collectContractMembersInto(contract, ast, items, seen, visited, {
    includeOwn: opts.includeOwn !== false,
    includeOwnPrivate: opts.includeOwnPrivate === true,
  });

  return items;
}

/**
 * Recursively collect members from a contract and its ancestors into the
 * provided arrays, deduplicating by name (first-declared wins).
 */
function collectContractMembersInto(
  contract: ContractDefinition,
  ast: AstNode,
  items: CompletionItem[],
  seen: Set<string>,
  visited: Set<number>,
  opts: { includeOwn: boolean; includeOwnPrivate: boolean }
): void {
  if (visited.has(contract.id)) return;
  visited.add(contract.id);

  if (opts.includeOwn) {
    const nodes = contract.nodes ?? [];
    for (const member of nodes) {
      if (member.name && seen.has(member.name)) continue;

      const vis = (member as any).visibility as string | undefined;
      // Private members are only visible within their own contract
      if (vis === 'private') {
        if (!opts.includeOwnPrivate) continue;
      }

      const item = contractMemberToCompletionItem(member);
      if (item) {
        if (member.name) seen.add(member.name);
        items.push(item);
      }
    }
  }

  // Walk base contracts (the inheritance chain)
  const baseContracts = (contract as any).baseContracts ?? [];
  for (const base of baseContracts) {
    const baseName = base.baseName?.name;
    if (!baseName) continue;

    const baseType = findTypeByName(ast, baseName);
    if (baseType && isContractDefinition(baseType)) {
      // For base contracts, always include their members (never private)
      collectContractMembersInto(baseType, ast, items, seen, visited, {
        includeOwn: true,
        includeOwnPrivate: false,
      });
    }
  }
}

/**
 * Convert a single contract member AST node into a CompletionItem.
 * Returns undefined for node types that don't produce completions.
 */
function contractMemberToCompletionItem(member: AstNode): CompletionItem | undefined {
  if (isFunctionDefinition(member)) {
    const fn = member as FunctionDefinition;
    const params =
      fn.parameters?.parameters
        ?.map((p) => {
          const tn = extractTypeName(p.typeName as AstNode);
          return `${tn} ${p.name}`;
        })
        .join(', ') ?? '';
    const docs = extractNatSpec(fn);
    return {
      label: fn.name!,
      kind: CompletionItemKind.Function,
      detail: `${fn.visibility} function ${fn.name}(${params})`,
      documentation: docs ? { kind: MarkupKind.Markdown, value: docs } : undefined,
    };
  }

  if (isStateVariableDeclaration(member)) {
    const sv = member as StateVariableDeclaration;
    return {
      label: sv.name!,
      kind: CompletionItemKind.Property,
      detail: `${sv.visibility} ${extractTypeName(sv.typeName as AstNode)} ${sv.name}`,
    };
  }

  if (isStructDefinition(member)) {
    return { label: member.name!, kind: CompletionItemKind.Struct };
  }

  if (isEnumDefinition(member)) {
    return { label: member.name!, kind: CompletionItemKind.Enum };
  }

  if (isEventDefinition(member)) {
    return { label: member.name!, kind: CompletionItemKind.Event };
  }

  if (isErrorDefinition(member)) {
    return { label: member.name!, kind: CompletionItemKind.Enum };
  }

  if (isModifierDefinition(member)) {
    return { label: member.name!, kind: CompletionItemKind.Function, detail: 'modifier' };
  }

  return undefined;
}

/**
 * Look up a member on a contract type, walking the inheritance chain.
 * Returns the resolved return-type string, or null.
 */
function resolveContractMemberType(
  contract: ContractDefinition,
  ast: AstNode,
  memberName: string
): string | null {
  const visited = new Set<number>();
  return resolveContractMemberTypeImpl(contract, ast, memberName, visited);
}

function resolveContractMemberTypeImpl(
  contract: ContractDefinition,
  ast: AstNode,
  memberName: string,
  visited: Set<number>
): string | null {
  if (visited.has(contract.id)) return null;
  visited.add(contract.id);

  const nodes = contract.nodes ?? [];
  for (const member of nodes) {
    if (member.name !== memberName) continue;

    if (isFunctionDefinition(member)) {
      const retParams = (member as FunctionDefinition).returnParameters?.parameters;
      if (retParams && retParams.length > 0) {
        return extractTypeName(retParams[0].typeName as AstNode);
      }
      return null;
    }
    if (isStateVariableDeclaration(member)) {
      return extractTypeName((member as StateVariableDeclaration).typeName as AstNode);
    }
  }

  // Walk base contracts
  const baseContracts = (contract as any).baseContracts ?? [];
  for (const base of baseContracts) {
    const baseName = base.baseName?.name;
    if (!baseName) continue;
    const baseType = findTypeByName(ast, baseName);
    if (baseType && isContractDefinition(baseType)) {
      const result = resolveContractMemberTypeImpl(baseType, ast, memberName, visited);
      if (result) return result;
    }
  }

  return null;
}

function findEnclosingContract(ast: AstNode, position: Position, content: string): AstNode | null {
  let found: AstNode | null = null;
  const offset = positionToOffset(content, position);

  walkAst(ast, (node) => {
    if (found) return false;
    if (isContractDefinition(node) && node.src) {
      const parsed = parseSrc(node.src);
      if (parsed && offset >= parsed.start && offset <= parsed.start + parsed.length) {
        found = node;
        return false;
      }
    }
    return true;
  });

  return found;
}

function provideNatSpecCompletion(ast: AstNode, position: Position, content: string): CompletionItem[] {
  const items: CompletionItem[] = [];

  // Determine context: are we inside a function, contract, event, etc.?
  const enclosingContract = findEnclosingContract(ast, position, content);
  const enclosingFunction = findEnclosingFunction(ast, position, content);
  const enclosingEvent = findEnclosingEvent(ast, position, content);

  // If inside a function, offer auto-generated NatSpec block with @param/@return
  if (enclosingFunction) {
    const fn = enclosingFunction as FunctionDefinition;
    const params = fn.parameters?.parameters ?? [];
    const returnParams = fn.returnParameters?.parameters ?? [];

    // Build auto-generated NatSpec block
    let autoBlock = '';
    autoBlock += '@notice ${1:Explain to an end user what this does}\n';
    autoBlock += '@dev ${2:Explain to a developer any extra details}\n';
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      const paramName = p.name ?? `param${i}`;
      const snippetIndex = i + 3;
      autoBlock += `@param ${paramName} \${${snippetIndex}:${paramName} description}\n`;
    }
    for (let i = 0; i < returnParams.length; i++) {
      const p = returnParams[i];
      const paramName = p.name ?? `ret${i}`;
      const snippetIndex = params.length + i + 3;
      autoBlock += `@return ${paramName} \${${snippetIndex}:${paramName} description}\n`;
    }

    items.push({
      label: '/** NatSpec block for function */',
      kind: CompletionItemKind.Snippet,
      insertText: autoBlock.trimEnd(),
      insertTextFormat: InsertTextFormat.Snippet,
      detail: `Auto-generate NatSpec for ${fn.name ?? 'function'} with ${params.length} params, ${returnParams.length} returns`,
    });
  }

  // If inside a contract (but not inside a function), offer contract-level template
  if (enclosingContract && !enclosingFunction) {
    const contractName = (enclosingContract as ContractDefinition).name ?? 'Contract';
    const contractKind = (enclosingContract as ContractDefinition).contractKind ?? 'contract';

    let contractBlock = '';
    contractBlock += `@title ${contractName}\n`;
    contractBlock += '@author ${1:Author name}\n';
    contractBlock += `@notice \${2:Explain to an end user what this ${contractKind} does}\n`;
    contractBlock += '@dev ${3:Explain to a developer any extra details}\n';

    items.push({
      label: '/** NatSpec block for contract */',
      kind: CompletionItemKind.Snippet,
      insertText: contractBlock.trimEnd(),
      insertTextFormat: InsertTextFormat.Snippet,
      detail: `Auto-generate NatSpec for ${contractKind} ${contractName}`,
    });
  }

  // If inside an event, offer event-level template
  if (enclosingEvent) {
    const eventName = (enclosingEvent as any).name ?? 'Event';
    const eventParams = (enclosingEvent as any).parameters?.parameters ?? [];

    let eventBlock = '';
    eventBlock += `@notice \${1:Emit when ...}\n`;
    eventBlock += '@dev ${2:Developer details}\n';
    for (let i = 0; i < eventParams.length; i++) {
      const p = eventParams[i];
      const paramName = p.name ?? `param${i}`;
      const snippetIndex = i + 3;
      eventBlock += `@param ${paramName} \${${snippetIndex}:${paramName} description}\n`;
    }

    items.push({
      label: '/** NatSpec block for event */',
      kind: CompletionItemKind.Snippet,
      insertText: eventBlock.trimEnd(),
      insertTextFormat: InsertTextFormat.Snippet,
      detail: `Auto-generate NatSpec for event ${eventName} with ${eventParams.length} params`,
    });
  }

  // Also offer individual tags
  const tags: [string, string, string][] = [
    ['@notice', '@notice ${1:Explain to an end user what this does}', 'User-facing description'],
    ['@dev', '@dev ${1:Explain to a developer any extra details}', 'Developer documentation'],
    ['@inheritdoc', '@inheritdoc ${1:ContractOrInterface}', 'Inherit docs from parent'],
    ['@author', '@author ${1:The name of the author}', 'Author name'],
    ['@title', '@title ${1:A title that should describe this}', 'Title'],
  ];

  if (enclosingFunction || enclosingEvent) {
    tags.push(
      ['@param', '@param ${1:name} ${2:Describe the parameter}', 'Parameter documentation'],
    );
  }

  if (enclosingFunction) {
    tags.push(
      ['@return', '@return ${1:Describe the return value}', 'Return value documentation'],
    );
  }

  for (const [label, snippet, desc] of tags) {
    items.push({
      label,
      kind: CompletionItemKind.Property,
      insertText: snippet,
      insertTextFormat: InsertTextFormat.Snippet,
      detail: desc,
    });
  }

  return items;
}

function findEnclosingFunction(ast: AstNode, position: Position, content: string): AstNode | null {
  let found: AstNode | null = null;
  const offset = positionToOffset(content, position);

  walkAst(ast, (node) => {
    if (found) return false;
    if (isFunctionDefinition(node) && node.src) {
      const parsed = parseSrc(node.src);
      if (parsed && offset >= parsed.start && offset <= parsed.start + parsed.length) {
        found = node;
        return false;
      }
    }
    return true;
  });

  return found;
}

// ─── Local variable scope resolution ───

interface VariableInScope {
  name: string;
  typeName: string;
  /** Byte offset where this declaration starts in the source */
  declOffset: number;
  /** Byte offset where the enclosing block starts (0 for function params) */
  blockOffset: number;
}

/**
 * Find all variable declarations that are in scope at a given byte offset.
 *
 * Walks the enclosing function's AST to collect:
 * - Function parameters (always in scope)
 * - State variables from the enclosing contract
 * - Local variable declarations (VariableDeclarationStatement)
 * - For-loop variable declarations
 * - Catch clause parameters
 *
 * A variable is considered "in scope" if:
 * 1. It is declared before the cursor offset
 * 2. Its declaration is in a block that contains the cursor position
 *
 * This mirrors the reference implementation's findVariableDeclarationsInScope.
 */
export function findVariableDeclarationsInScope(
  ast: AstNode,
  offset: number,
  content: string
): VariableInScope[] {
  const enclosingFunction = findEnclosingFunctionByOffset(ast, offset);
  if (!enclosingFunction) return [];

  const fn = enclosingFunction as FunctionDefinition;
  const results: VariableInScope[] = [];

  // 1. Function parameters are always in scope
  const params = fn.parameters?.parameters ?? [];
  for (const param of params) {
    if (param.name) {
      results.push({
        name: param.name,
        typeName: extractTypeName(param.typeName as AstNode),
        declOffset: 0, // params are always in scope
        blockOffset: 0,
      });
    }
  }

  // 2. Walk the function body to find local variable declarations
  const body = fn.body;
  if (body) {
    collectDeclarationsInScope(body, offset, results);
  }

  // 3. State variables from the enclosing contract are also in scope
  const enclosingContract = findEnclosingContractByOffset(ast, offset);
  if (enclosingContract) {
    const contract = enclosingContract as ContractDefinition;
    const nodes = contract.nodes ?? [];
    for (const member of nodes) {
      if (isStateVariableDeclaration(member) && member.name) {
        results.push({
          name: member.name,
          typeName: extractTypeName((member as StateVariableDeclaration).typeName as AstNode),
          declOffset: 0, // state variables are always in scope within the contract
          blockOffset: 0,
        });
      }
    }
  }

  return results;
}

/**
 * Find the enclosing function at a given byte offset.
 */
function findEnclosingFunctionByOffset(ast: AstNode, offset: number): AstNode | null {
  let found: AstNode | null = null;

  walkAst(ast, (node) => {
    if (found) return false;
    if (isFunctionDefinition(node) && node.src) {
      const parsed = parseSrc(node.src);
      if (parsed && offset >= parsed.start && offset <= parsed.start + parsed.length) {
        found = node;
        return false;
      }
    }
    return true;
  });

  return found;
}

/**
 * Find the enclosing contract at a given byte offset.
 */
function findEnclosingContractByOffset(ast: AstNode, offset: number): AstNode | null {
  let found: AstNode | null = null;

  walkAst(ast, (node) => {
    if (found) return false;
    if (isContractDefinition(node) && node.src) {
      const parsed = parseSrc(node.src);
      if (parsed && offset >= parsed.start && offset <= parsed.start + parsed.length) {
        found = node;
        return false;
      }
    }
    return true;
  });

  return found;
}

/**
 * Recursively collect variable declarations from a Block node that are in scope
 * at the given byte offset.
 *
 * Handles:
 * - VariableDeclarationStatement (local variables)
 * - ForStatement (loop variable declarations in init)
 * - TryCatchClause (catch clause parameters)
 * - Nested blocks (recurses into children)
 */
function collectDeclarationsInScope(
  node: AstNode,
  targetOffset: number,
  results: VariableInScope[]
): void {
  // Only process Block nodes (function bodies, if/else/for/while/try/catch blocks)
  if (node.nodeType !== 'Block') return;

  const blockParsed = parseSrc(node.src);
  if (!blockParsed) return;

  // Check if this block contains the target offset
  const blockStart = blockParsed.start;
  const blockEnd = blockStart + blockParsed.length;
  if (targetOffset < blockStart || targetOffset > blockEnd) return;

  // Process statements in this block
  const statements = (node as any).statements ?? [];
  for (const stmt of statements) {
    if (!stmt.src) continue;

    const stmtParsed = parseSrc(stmt.src);
    if (!stmtParsed) continue;

    // Only include statements declared before the target offset
    if (stmtParsed.start >= targetOffset) continue;

    // VariableDeclarationStatement: contains declarations array
    if (stmt.nodeType === 'VariableDeclarationStatement') {
      const declarations = (stmt as any).declarations ?? [];
      for (const decl of declarations) {
        if (decl.name && decl.src) {
          const declParsed = parseSrc(decl.src);
          if (declParsed && declParsed.start < targetOffset) {
            results.push({
              name: decl.name,
              typeName: extractTypeName(decl.typeName as AstNode),
              declOffset: declParsed.start,
              blockOffset: blockStart,
            });
          }
        }
      }
    }

    // ForStatement: check init for variable declarations
    if (stmt.nodeType === 'ForStatement') {
      const initializations = (stmt as any).initializations ?? [];
      for (const init of initializations) {
        if (init.nodeType === 'VariableDeclarationStatement') {
          const declarations = (init as any).declarations ?? [];
          for (const decl of declarations) {
            if (decl.name && decl.src) {
              const declParsed = parseSrc(decl.src);
              if (declParsed && declParsed.start < targetOffset) {
                results.push({
                  name: decl.name,
                  typeName: extractTypeName(decl.typeName as AstNode),
                  declOffset: declParsed.start,
                  blockOffset: blockStart,
                });
              }
            }
          }
        }
      }

      // Also check the loop body block for nested declarations
      const body = (stmt as any).body;
      if (body) {
        collectDeclarationsInScope(body, targetOffset, results);
      }
    }

    // Recurse into nested blocks (if/else bodies, while/for bodies, etc.)
    collectNestedBlockDeclarations(stmt, targetOffset, results);
  }
}

/**
 * Recursively collect variable declarations from nested block structures.
 * Handles IfStatement, WhileStatement, DoWhileStatement, UncheckedStatement,
 * Block (inline blocks), and TryStatement (try body + catch clauses).
 */
function collectNestedBlockDeclarations(
  node: AstNode,
  targetOffset: number,
  results: VariableInScope[]
): void {
  // IfStatement: trueBody and falseBody are Blocks
  if (node.nodeType === 'IfStatement') {
    const trueBody = (node as any).trueBody;
    const falseBody = (node as any).falseBody;
    if (trueBody) collectDeclarationsInScope(trueBody, targetOffset, results);
    if (falseBody) collectDeclarationsInScope(falseBody, targetOffset, results);
  }

  // WhileStatement: body is a Block
  if (node.nodeType === 'WhileStatement') {
    const body = (node as any).body;
    if (body) collectDeclarationsInScope(body, targetOffset, results);
  }

  // DoWhileStatement: body is a Block
  if (node.nodeType === 'DoWhileStatement') {
    const body = (node as any).body;
    if (body) collectDeclarationsInScope(body, targetOffset, results);
  }

  // UncheckedStatement: body is a Block
  if (node.nodeType === 'UncheckedStatement') {
    const body = (node as any).body;
    if (body) collectDeclarationsInScope(body, targetOffset, results);
  }

  // Block (inline block: { ... })
  if (node.nodeType === 'Block') {
    collectDeclarationsInScope(node, targetOffset, results);
  }

  // TryStatement: try body + catch clauses
  if (node.nodeType === 'TryStatement') {
    const body = (node as any).body;
    if (body) collectDeclarationsInScope(body, targetOffset, results);

    const clauses = (node as any).clauses ?? [];
    for (const clause of clauses) {
      if (clause.nodeType === 'TryCatchClause') {
        // Check catch clause parameters
        const parameters = (clause as any).parameters;
        if (parameters && Array.isArray(parameters)) {
          for (const param of parameters) {
            if (param.name && param.src) {
              const paramParsed = parseSrc(param.src);
              if (paramParsed && paramParsed.start < targetOffset) {
                results.push({
                  name: param.name,
                  typeName: extractTypeName(param.typeName as AstNode),
                  declOffset: paramParsed.start,
                  blockOffset: 0,
                });
              }
            }
          }
        }

        // Recurse into catch clause body
        const clauseBody = (clause as any).block;
        if (clauseBody) {
          collectDeclarationsInScope(clauseBody, targetOffset, results);
        }
      }
    }
  }

  // EmitStatement, ExpressionStatement, ReturnStatement, etc. — no nested blocks
  // AssemblyBlock — not handling assembly variables for now
}

function findEnclosingEvent(ast: AstNode, position: Position, content: string): AstNode | null {
  let found: AstNode | null = null;
  const offset = positionToOffset(content, position);

  walkAst(ast, (node) => {
    if (found) return false;
    if (isEventDefinition(node) && node.src) {
      const parsed = parseSrc(node.src);
      if (parsed && offset >= parsed.start && offset <= parsed.start + parsed.length) {
        found = node;
        return false;
      }
    }
    return true;
  });

  return found;
}
