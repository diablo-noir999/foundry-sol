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
  isContractDefinition,
  isFunctionDefinition,
  isStateVariableDeclaration,
  isStructDefinition,
  isEnumDefinition,
  isEventDefinition,
  isErrorDefinition,
  isModifierDefinition,
  isImportDirective,
  Identifier,
  isIdentifier,
} from '../ast/types';
import { CompileResult } from '../compiler/cache';
import { FoundryProject } from '../project';
import { parseSrc } from '../ast/traversal';

const SOLIDITY_KEYWORDS: [string, string][] = [
  ['pragma', 'pragma solidity ^0.8.0;'],
  ['contract', 'contract ${1:Name} {\n\t$0\n}'],
  ['interface', 'interface ${1:Name} {\n\t$0\n}'],
  ['library', 'library ${1:Name} {\n\t$0\n}'],
  ['function', 'function ${1:name}(${2:params}) ${3:public} ${4:nonpayable} {\n\t$0\n}'],
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
  ['nonpayable', 'nonpayable'],
  ['virtual', 'virtual'],
  ['override', 'override'],
  ['abstract', 'abstract'],
  ['immutable', 'immutable'],
  ['constant', 'constant'],
  ['memory', 'memory'],
  ['storage', 'storage'],
  ['calldata', 'calldata'],
  ['anonymous', 'anonymous'],
  ['indexed', 'indexed'],
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
  ['int', 'Signed integer (alias for int256)'],
  ['uint', 'Unsigned integer (alias for uint256)'],
  ['int8', 'Signed integer (8 bits)'],
  ['int16', 'Signed integer (16 bits)'],
  ['int24', 'Signed integer (24 bits)'],
  ['int32', 'Signed integer (32 bits)'],
  ['int40', 'Signed integer (40 bits)'],
  ['int48', 'Signed integer (48 bits)'],
  ['int56', 'Signed integer (56 bits)'],
  ['int64', 'Signed integer (64 bits)'],
  ['int72', 'Signed integer (72 bits)'],
  ['int80', 'Signed integer (80 bits)'],
  ['int88', 'Signed integer (88 bits)'],
  ['int96', 'Signed integer (96 bits)'],
  ['int104', 'Signed integer (104 bits)'],
  ['int112', 'Signed integer (112 bits)'],
  ['int120', 'Signed integer (120 bits)'],
  ['int128', 'Signed integer (128 bits)'],
  ['int136', 'Signed integer (136 bits)'],
  ['int144', 'Signed integer (144 bits)'],
  ['int152', 'Signed integer (152 bits)'],
  ['int160', 'Signed integer (160 bits)'],
  ['int168', 'Signed integer (168 bits)'],
  ['int176', 'Signed integer (176 bits)'],
  ['int184', 'Signed integer (184 bits)'],
  ['int192', 'Signed integer (192 bits)'],
  ['int200', 'Signed integer (200 bits)'],
  ['int208', 'Signed integer (208 bits)'],
  ['int216', 'Signed integer (216 bits)'],
  ['int224', 'Signed integer (224 bits)'],
  ['int232', 'Signed integer (232 bits)'],
  ['int240', 'Signed integer (240 bits)'],
  ['int248', 'Signed integer (248 bits)'],
  ['int256', 'Signed integer (256 bits)'],
  ['uint8', 'Unsigned integer (8 bits)'],
  ['uint16', 'Unsigned integer (16 bits)'],
  ['uint24', 'Unsigned integer (24 bits)'],
  ['uint32', 'Unsigned integer (32 bits)'],
  ['uint40', 'Unsigned integer (40 bits)'],
  ['uint48', 'Unsigned integer (48 bits)'],
  ['uint56', 'Unsigned integer (56 bits)'],
  ['uint64', 'Unsigned integer (64 bits)'],
  ['uint72', 'Unsigned integer (72 bits)'],
  ['uint80', 'Unsigned integer (80 bits)'],
  ['uint88', 'Unsigned integer (88 bits)'],
  ['uint96', 'Unsigned integer (96 bits)'],
  ['uint104', 'Unsigned integer (104 bits)'],
  ['uint112', 'Unsigned integer (112 bits)'],
  ['uint120', 'Unsigned integer (120 bits)'],
  ['uint128', 'Unsigned integer (128 bits)'],
  ['uint136', 'Unsigned integer (136 bits)'],
  ['uint144', 'Unsigned integer (144 bits)'],
  ['uint152', 'Unsigned integer (152 bits)'],
  ['uint160', 'Unsigned integer (160 bits)'],
  ['uint168', 'Unsigned integer (168 bits)'],
  ['uint176', 'Unsigned integer (176 bits)'],
  ['uint184', 'Unsigned integer (184 bits)'],
  ['uint192', 'Unsigned integer (192 bits)'],
  ['uint200', 'Unsigned integer (200 bits)'],
  ['uint208', 'Unsigned integer (208 bits)'],
  ['uint216', 'Unsigned integer (216 bits)'],
  ['uint224', 'Unsigned integer (224 bits)'],
  ['uint232', 'Unsigned integer (232 bits)'],
  ['uint240', 'Unsigned integer (240 bits)'],
  ['uint248', 'Unsigned integer (248 bits)'],
  ['uint256', 'Unsigned integer (256 bits)'],
  ['bytes1', 'Fixed-size byte array (1 byte)'],
  ['bytes2', 'Fixed-size byte array (2 bytes)'],
  ['bytes3', 'Fixed-size byte array (3 bytes)'],
  ['bytes4', 'Fixed-size byte array (4 bytes)'],
  ['bytes5', 'Fixed-size byte array (5 bytes)'],
  ['bytes6', 'Fixed-size byte array (6 bytes)'],
  ['bytes7', 'Fixed-size byte array (7 bytes)'],
  ['bytes8', 'Fixed-size byte array (8 bytes)'],
  ['bytes9', 'Fixed-size byte array (9 bytes)'],
  ['bytes10', 'Fixed-size byte array (10 bytes)'],
  ['bytes11', 'Fixed-size byte array (11 bytes)'],
  ['bytes12', 'Fixed-size byte array (12 bytes)'],
  ['bytes13', 'Fixed-size byte array (13 bytes)'],
  ['bytes14', 'Fixed-size byte array (14 bytes)'],
  ['bytes15', 'Fixed-size byte array (15 bytes)'],
  ['bytes16', 'Fixed-size byte array (16 bytes)'],
  ['bytes17', 'Fixed-size byte array (17 bytes)'],
  ['bytes18', 'Fixed-size byte array (18 bytes)'],
  ['bytes19', 'Fixed-size byte array (19 bytes)'],
  ['bytes20', 'Fixed-size byte array (20 bytes)'],
  ['bytes21', 'Fixed-size byte array (21 bytes)'],
  ['bytes22', 'Fixed-size byte array (22 bytes)'],
  ['bytes23', 'Fixed-size byte array (23 bytes)'],
  ['bytes24', 'Fixed-size byte array (24 bytes)'],
  ['bytes25', 'Fixed-size byte array (25 bytes)'],
  ['bytes26', 'Fixed-size byte array (26 bytes)'],
  ['bytes27', 'Fixed-size byte array (27 bytes)'],
  ['bytes28', 'Fixed-size byte array (28 bytes)'],
  ['bytes29', 'Fixed-size byte array (29 bytes)'],
  ['bytes30', 'Fixed-size byte array (30 bytes)'],
  ['bytes31', 'Fixed-size byte array (31 bytes)'],
  ['bytes32', 'Fixed-size byte array (32 bytes)'],
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

export function provideCompletion(
  ast: AstNode,
  document: TextDocument,
  position: Position,
  _compileResult: CompileResult,
  project: FoundryProject | undefined
): CompletionItem[] {
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
    return provideImportCompletion(importMatch[1], position, project);
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
    items.push({
      label: keyword,
      kind: CompletionItemKind.Keyword,
      insertText: snippet,
      insertTextFormat: InsertTextFormat.Snippet,
      detail: 'Solidity keyword',
    });
  }

  // 10. AST identifiers
  const idItems = collectIdentifiers(ast, content, prefix);
  items.push(...idItems);

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

  // 11.1: `this.` — resolve to current contract's own members
  if (rootName === 'this') {
    const enclosingContract = findEnclosingContract(ast, position, content);
    if (enclosingContract) {
      const nodes = (enclosingContract as ContractDefinition).nodes ?? [];
      const items: CompletionItem[] = [];
      for (const member of nodes) {
        const vis = (member as any).visibility;
        // Show non-private members (public, internal, external)
        if (vis === 'private') continue;
        if (isFunctionDefinition(member)) {
          const fn = member as FunctionDefinition;
          const params = fn.parameters?.parameters
            ?.map((p) => `${extractTypeName(p.typeName as AstNode)} ${p.name}`)
            .join(', ') ?? '';
          items.push({
            label: fn.name!,
            kind: CompletionItemKind.Function,
            detail: `${fn.visibility} function ${fn.name}(${params})`,
          });
        } else if (isStateVariableDeclaration(member)) {
          const sv = member as StateVariableDeclaration;
          items.push({
            label: sv.name!,
            kind: CompletionItemKind.Property,
            detail: `${sv.visibility} ${extractTypeName(sv.typeName as AstNode)} ${sv.name}`,
          });
        } else if (isEventDefinition(member)) {
          items.push({ label: member.name!, kind: CompletionItemKind.Event });
        } else if (isErrorDefinition(member)) {
          items.push({ label: member.name!, kind: CompletionItemKind.Enum });
        }
      }
      return items;
    }
  }

  // 11.2: `super.` — resolve to parent contract's non-private members
  if (rootName === 'super') {
    const enclosingContract = findEnclosingContract(ast, position, content);
    if (enclosingContract) {
      const baseContracts = (enclosingContract as any).baseContracts ?? [];
      const items: CompletionItem[] = [];
      const seen = new Set<string>();
      for (const base of baseContracts) {
        const baseName = base.baseName?.name;
        if (!baseName) continue;
        const baseType = findTypeByName(ast, baseName);
        if (!baseType || !isContractDefinition(baseType)) continue;
        const nodes = (baseType as ContractDefinition).nodes ?? [];
        for (const member of nodes) {
          const vis = (member as any).visibility;
          if (vis === 'private') continue;
          if (member.name && !seen.has(member.name)) {
            seen.add(member.name);
            if (isFunctionDefinition(member)) {
              const fn = member as FunctionDefinition;
              const params = fn.parameters?.parameters
                ?.map((p) => `${extractTypeName(p.typeName as AstNode)} ${p.name}`)
                .join(', ') ?? '';
              items.push({
                label: fn.name!,
                kind: CompletionItemKind.Function,
                detail: `${fn.visibility} function ${fn.name}(${params})`,
              });
            } else if (isStateVariableDeclaration(member)) {
              const sv = member as StateVariableDeclaration;
              items.push({
                label: sv.name!,
                kind: CompletionItemKind.Property,
                detail: `${sv.visibility} ${extractTypeName(sv.typeName as AstNode)} ${sv.name}`,
              });
            }
          }
        }
      }
      return items;
    }
  }

  // 11.3: Global object sub-properties (msg., block., tx., abi.)
  if (parts.length === 2 && GLOBAL_OBJECT_MEMBERS[rootName]) {
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
    const nodes = (typeDef as ContractDefinition).nodes ?? [];
    for (const member of nodes) {
      if (isFunctionDefinition(member) && member.name === memberName) {
        const retParams = (member as FunctionDefinition).returnParameters?.parameters;
        if (retParams && retParams.length > 0) {
          return extractTypeName(retParams[0].typeName as AstNode);
        }
        return null;
      }
      if (isStateVariableDeclaration(member) && member.name === memberName) {
        return extractTypeName((member as StateVariableDeclaration).typeName as AstNode);
      }
    }
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
    const nodes = (typeDef as ContractDefinition).nodes ?? [];
    for (const member of nodes) {
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
        items.push({
          label: fn.name!,
          kind: CompletionItemKind.Function,
          detail: `${fn.visibility} function ${fn.name}(${params})`,
          documentation: docs ? { kind: MarkupKind.Markdown, value: docs } : undefined,
        });
      } else if (isStateVariableDeclaration(member)) {
        const sv = member as StateVariableDeclaration;
        items.push({
          label: sv.name!,
          kind: CompletionItemKind.Property,
          detail: `${sv.visibility} ${extractTypeName(sv.typeName as AstNode)} ${sv.name}`,
        });
      } else if (isStructDefinition(member)) {
        items.push({
          label: member.name!,
          kind: CompletionItemKind.Struct,
        });
      } else if (isEnumDefinition(member)) {
        items.push({
          label: member.name!,
          kind: CompletionItemKind.Enum,
        });
      } else if (isEventDefinition(member)) {
        items.push({
          label: member.name!,
          kind: CompletionItemKind.Event,
        });
      } else if (isErrorDefinition(member)) {
        items.push({
          label: member.name!,
          kind: CompletionItemKind.Enum,
        });
      } else if (isModifierDefinition(member)) {
        items.push({
          label: member.name!,
          kind: CompletionItemKind.Function,
          detail: 'modifier',
        });
      }
    }
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

function provideImportCompletion(
  partial: string,
  position: Position,
  project: FoundryProject | undefined
): CompletionItem[] {
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
    if (!fs.existsSync(targetDir)) continue;

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
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

function extractTypeName(node: AstNode): string {
  if (!node) return 'unknown';
  if (node.name) return node.name;
  if (node.nodeType === 'ElementaryTypeName') return node.name!;
  if (node.nodeType === 'UserDefinedTypeName') return node.name!;
  if (node.nodeType === 'Mapping') {
    const key = extractTypeName(node.keyType as AstNode);
    const value = extractTypeName(node.valueType as AstNode);
    return `mapping(${key} => ${value})`;
  }
  if (node.nodeType === 'ArrayTypeName') {
    const base = extractTypeName(node.baseType as AstNode);
    return `${base}[]`;
  }
  const typeDesc = node.typeDescriptions as { typeString?: string } | undefined;
  return typeDesc?.typeString ?? 'unknown';
}

function extractNatSpec(node: AstNode): string {
  const doc = node.documentation as
    | { nodeType?: string; text?: string }
    | undefined;
  if (!doc?.text) return '';

  const lines = doc.text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const parts: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@notice')) {
      parts.push(line.replace('@notice', '').trim());
    } else if (line.startsWith('@dev')) {
      parts.push(line.replace('@dev', '').trim());
    } else if (line.startsWith('@param')) {
      parts.push(line);
    } else if (line.startsWith('@return')) {
      parts.push(line);
    }
  }

  return parts.join('\n');
}

function walkAst(node: AstNode, callback: (node: AstNode) => boolean): void {
  if (!callback(node)) return;
  if (node.nodes) {
    for (const child of node.nodes) {
      walkAst(child, callback);
    }
  }
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

  // Determine context: are we inside a function, contract, etc.?
  const enclosingContract = findEnclosingContract(ast, position, content);
  const enclosingFunction = findEnclosingFunction(ast, position, content);

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
      label: '/** NatSpec block */',
      kind: CompletionItemKind.Snippet,
      insertText: autoBlock.trimEnd(),
      insertTextFormat: InsertTextFormat.Snippet,
      detail: `Auto-generate NatSpec for ${fn.name ?? 'function'} with ${params.length} params`,
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

  if (enclosingFunction) {
    tags.push(
      ['@param', '@param ${1:name} ${2:Describe the parameter}', 'Parameter documentation'],
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

function positionToOffset(content: string, position: Position): number {
  let offset = 0;
  const lines = content.split('\n');
  for (let i = 0; i < position.line && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for \n
  }
  return offset + position.character;
}
