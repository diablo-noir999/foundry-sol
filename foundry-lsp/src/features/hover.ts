import { Hover, MarkupContent, MarkupKind, Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  AstNode,
  FunctionDefinition,
  StateVariableDeclaration,
  ContractDefinition,
  VariableDeclaration,
  ImportDirective,
  isFunctionDefinition,
  isStateVariableDeclaration,
  isContractDefinition,
  isVariableDeclaration,
  isImportDirective,
  isStructDefinition,
  isEnumDefinition,
  isEventDefinition,
  isErrorDefinition,
  isModifierDefinition,
  isElementaryTypeName,
  isUserDefinedTypeName,
  isMapping,
  isArrayTypeName,
  Identifier,
  MemberAccess,
  isIdentifier,
  isMemberAccess,
} from '../ast/types';
import {
  findNodeAtPosition,
  srcToRange,
  positionToOffset,
  parseSrc,
} from '../ast/traversal';
import { CompileResult } from '../compiler/cache';

export function provideHover(
  ast: AstNode,
  document: TextDocument,
  position: Position,
  _compileResult: CompileResult
): Hover | null {
  const content = document.getText();
  const node = findNodeAtPosition(ast, content, position);
  if (!node) return null;

  const range = node.src ? srcToRange(node.src, content) : null;

  // Identifier or MemberAccess — try to find what it refers to
  if (isIdentifier(node) || isMemberAccess(node)) {
    return hoverIdentifier(node, ast, content, range);
  }

  // Direct definition nodes
  if (isFunctionDefinition(node)) {
    return hoverFunction(node, content, range);
  }

  if (isStateVariableDeclaration(node)) {
    // Check if cursor is on the type name — resolve it
    const sv = node as StateVariableDeclaration;
    if (sv.typeName) {
      const typeNameNode = sv.typeName as unknown as AstNode;
      const typeNameSrc = typeNameNode.src;
      if (typeNameSrc) {
        const parsed = parseSrc(typeNameSrc);
        const offset = positionToOffset(content, position);
        if (parsed && offset >= parsed.start && offset <= parsed.start + parsed.length) {
          // Cursor is on the type name — resolve it
          const resolved = resolveTypeName(typeNameNode, ast, content, range);
          if (resolved) return resolved;
        }
      }
    }
    return hoverStateVariable(node, content, range);
  }

  if (isContractDefinition(node)) {
    return hoverContract(node, range);
  }

  if (isVariableDeclaration(node)) {
    return hoverParameter(node, range);
  }

  if (isImportDirective(node)) {
    // Check if cursor is on a named import symbol — resolve to the actual type
    const resolved = resolveImportSymbol(node, content, position, ast);
    if (resolved) return resolved;
    return hoverImport(node, range);
  }

  if (isStructDefinition(node) || isEnumDefinition(node)) {
    return hoverTypeDefinition(node, content, range);
  }

  if (isEventDefinition(node)) {
    return hoverEvent(node, content, range);
  }

  if (isErrorDefinition(node)) {
    return hoverError(node, content, range);
  }

  if (isModifierDefinition(node)) {
    return hoverModifier(node, content, range);
  }

  // Type names
  if (isElementaryTypeName(node)) {
    return hoverElementaryType(node, range);
  }

  if (isUserDefinedTypeName(node)) {
    return hoverUserDefinedType(node, ast, range);
  }

  if (isMapping(node)) {
    return hoverMapping(node, content, range);
  }

  if (isArrayTypeName(node)) {
    return hoverArray(node, content, range);
  }

  return null;
}

function hoverIdentifier(
  node: Identifier | MemberAccess,
  ast: AstNode,
  content: string,
  range: ReturnType<typeof srcToRange>
): Hover | null {
  const name = node.name || (node as MemberAccess).memberName;
  if (!name) return null;

  // Try to find the referenced definition
  const refId = (node as Identifier).referencedDeclaration;
  if (refId !== undefined) {
    const def = findNodeById(ast, refId);
    if (def) {
      if (isFunctionDefinition(def)) {
        return hoverFunction(def, content, range);
      }
      if (isStateVariableDeclaration(def)) {
        return hoverStateVariable(def, content, range);
      }
      if (isContractDefinition(def)) {
        return hoverContract(def, range);
      }
      if (isVariableDeclaration(def)) {
        return hoverParameter(def, range);
      }
      if (isStructDefinition(def) || isEnumDefinition(def)) {
        return hoverTypeDefinition(def, content, range);
      }
      if (isEventDefinition(def)) {
        return hoverEvent(def, content, range);
      }
      if (isModifierDefinition(def)) {
        return hoverModifier(def, content, range);
      }
    }
  }

  // Fallback: search by name
  const def = findDefinitionByName(ast, name);
  if (def) {
    if (isFunctionDefinition(def)) {
      return hoverFunction(def, content, range);
    }
    if (isStateVariableDeclaration(def)) {
      return hoverStateVariable(def, content, range);
    }
    if (isContractDefinition(def)) {
      return hoverContract(def, range);
    }
  }

  // Last resort: check if this identifier is a named import symbol
  const importInfo = findImportForSymbol(ast, name);
  if (importInfo) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `\`${name}\` from \`${importInfo}\``,
      },
      range: range ?? undefined,
    };
  }

  return null;
}

function hoverFunction(
  node: FunctionDefinition,
  content: string,
  range: ReturnType<typeof srcToRange>
): Hover {
  const sig = buildFunctionSignature(node, content);
  const docs = extractNatSpec(node);
  const lines = ['```solidity', sig, '```'];
  if (docs) lines.push('', docs);

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

function hoverStateVariable(
  node: StateVariableDeclaration,
  content: string,
  range: ReturnType<typeof srcToRange>
): Hover {
  const typeName = extractTypeName(node.typeName as AstNode, content);
  const mutability = node.constant
    ? 'constant'
    : node.immutable
    ? 'immutable'
    : '';
  const vis = node.visibility;
  const decl = `${mutability ? mutability + ' ' : ''}${vis} ${typeName} ${node.name}`;
  const docs = extractNatSpec(node);
  const lines = ['```solidity', decl.trim(), '```'];
  if (docs) lines.push('', docs);

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

function hoverContract(
  node: ContractDefinition,
  range: ReturnType<typeof srcToRange>
): Hover {
  const kind = node.contractKind;
  const docs = extractNatSpec(node);
  const lines = [`**${kind}** \`${node.name}\``];
  if (docs) lines.push('', docs);

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

function hoverParameter(
  node: VariableDeclaration,
  range: ReturnType<typeof srcToRange>
): Hover {
  const typeName = extractTypeName(node.typeName as AstNode, '');
  const lines = ['```solidity', `${typeName} ${node.name}`, '```'];

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

function hoverImport(
  node: ImportDirective,
  range: ReturnType<typeof srcToRange>
): Hover {
  const file = node.file || '';
  const alias = node.unitAlias
    ? ` as ${node.unitAlias}`
    : node.symbolAliases
    ? ` { ${node.symbolAliases
        .map((a) => {
          const foreign = a.foreign?.name || '?';
          const local = a.local?.name || '?';
          return foreign === local ? foreign : `${foreign} as ${local}`;
        })
        .join(', ')} }`
    : '';

  const lines = ['```solidity', `import "${file}"${alias};`, '```'];

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

function resolveImportSymbol(
  importNode: ImportDirective,
  content: string,
  position: Position,
  ast: AstNode
): Hover | null {
  if (!importNode.symbolAliases) return null;

  const offset = positionToOffset(content, position);

  for (const alias of importNode.symbolAliases) {
    const foreign = alias.foreign as unknown as AstNode;
    if (!foreign?.src) continue;

    const parsed = parseSrc(foreign.src);
    if (!parsed) continue;

    if (offset >= parsed.start && offset <= parsed.start + parsed.length) {
      // Found the symbol — resolve it via referencedDeclaration
      const refId = (foreign as any).referencedDeclaration;
      if (refId !== undefined) {
        const def = findNodeById(ast, refId);
        if (def) {
          const range = def.src ? srcToRange(def.src, content) : null;
          if (isContractDefinition(def)) return hoverContract(def, range);
          if (isFunctionDefinition(def)) return hoverFunction(def, content, range);
          if (isStructDefinition(def) || isEnumDefinition(def))
            return hoverTypeDefinition(def, content, range);
        }
      }

      // Fallback: show the import symbol with its path
      const name = foreign.name || '?';
      const file = importNode.file || '';
      const symRange = srcToRange(foreign.src, content);
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `\`${name}\` from \`${file}\``,
        },
        range: symRange ?? undefined,
      };
    }
  }

  return null;
}

function hoverTypeDefinition(
  node: AstNode,
  content: string,
  range: ReturnType<typeof srcToRange>
): Hover {
  const kind = node.nodeType === 'StructDefinition' ? 'struct' : 'enum';
  const members =
    node.nodeType === 'StructDefinition'
      ? ((node as unknown as { members: VariableDeclaration[] }).members)
      : node.nodeType === 'EnumDefinition'
      ? ((node as unknown as { values: { name: string }[] }).values)
      : [];

  const lines = ['```solidity', `${kind} ${node.name} {`];
  for (const m of members) {
    if (node.nodeType === 'StructDefinition') {
      const typeName = extractTypeName((m as VariableDeclaration).typeName as AstNode, content);
      lines.push(`  ${typeName} ${(m as VariableDeclaration).name};`);
    } else {
      lines.push(`  ${(m as { name: string }).name},`);
    }
  }
  lines.push('}', '```');

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

function hoverEvent(
  node: AstNode,
  content: string,
  range: ReturnType<typeof srcToRange>
): Hover {
  const params = (node as unknown as { parameters: { parameters: VariableDeclaration[] } }).parameters;
  const paramList = params?.parameters
    ?.map((p) => {
      const typeName = extractTypeName(p.typeName as AstNode, content);
      return `${typeName} ${p.name}`;
    })
    .join(', ') ?? '';

  const lines = ['```solidity', `event ${node.name}(${paramList});`, '```'];

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

function hoverError(
  node: AstNode,
  content: string,
  range: ReturnType<typeof srcToRange>
): Hover {
  const params = (node as unknown as { parameters: { parameters: VariableDeclaration[] } }).parameters;
  const paramList = params?.parameters
    ?.map((p) => {
      const typeName = extractTypeName(p.typeName as AstNode, content);
      return `${typeName} ${p.name}`;
    })
    .join(', ') ?? '';

  const lines = ['```solidity', `error ${node.name}(${paramList});`, '```'];

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

function hoverModifier(
  node: AstNode,
  content: string,
  range: ReturnType<typeof srcToRange>
): Hover {
  const params = (node as unknown as { parameters?: { parameters: VariableDeclaration[] } }).parameters;
  const paramList = params?.parameters
    ?.map((p) => {
      const typeName = extractTypeName(p.typeName as AstNode, content);
      return `${typeName} ${p.name}`;
    })
    .join(', ') ?? '';

  const lines = ['```solidity', `modifier ${node.name}(${paramList})`, '```'];

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

function hoverElementaryType(
  node: AstNode,
  range: ReturnType<typeof srcToRange>
): Hover {
  const desc = getSolidityTypeDescription(node.name!);
  const lines = ['```solidity', node.name, '```', '', desc];

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

function hoverUserDefinedType(
  node: AstNode,
  ast: AstNode,
  range: ReturnType<typeof srcToRange>
): Hover {
  const name = node.name;
  const def = findDefinitionByName(ast, name!);
  if (def) {
    if (isContractDefinition(def)) {
      return hoverContract(def, range);
    }
    if (isStructDefinition(def) || isEnumDefinition(def)) {
      return hoverTypeDefinition(def, '', range);
    }
  }

  return {
    contents: { kind: MarkupKind.Markdown, value: `\`${name}\`` },
    range: range ?? undefined,
  };
}

function hoverMapping(
  node: AstNode,
  content: string,
  range: ReturnType<typeof srcToRange>
): Hover {
  const keyType = extractTypeName(node.keyType as AstNode, content);
  const valueType = extractTypeName(node.valueType as AstNode, content);
  const lines = ['```solidity', `mapping(${keyType} => ${valueType})`, '```'];

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

function hoverArray(
  node: AstNode,
  content: string,
  range: ReturnType<typeof srcToRange>
): Hover {
  const baseType = extractTypeName(node.baseType as AstNode, content);
  const lines = ['```solidity', `${baseType}[]`, '```'];

  return {
    contents: { kind: MarkupKind.Markdown, value: lines.join('\n') },
    range: range ?? undefined,
  };
}

// ─── Helpers ───

function buildFunctionSignature(
  node: FunctionDefinition,
  content: string
): string {
  const params =
    node.parameters?.parameters
      ?.map((p) => {
        const typeName = extractTypeName(p.typeName as AstNode, content);
        return `${typeName}${p.name ? ' ' + p.name : ''}`;
      })
      .join(', ') ?? '';

  const returns =
    node.returnParameters?.parameters
      ?.map((p) => {
        const typeName = extractTypeName(p.typeName as AstNode, content);
        return `${typeName}${p.name ? ' ' + p.name : ''}`;
      })
      .join(', ') ?? '';

  const kind = (node as any).kind || 'function';

  if (kind === 'constructor') {
    const parts: string[] = [];
    if (node.visibility && node.visibility !== 'public') parts.push(node.visibility);
    const mut = node.stateMutability;
    if (mut && mut !== 'nonpayable') parts.push(mut);
    const returnStr = returns ? ` returns (${returns})` : '';
    return `constructor(${params})${returnStr}${parts.length ? ' ' + parts.join(' ') : ''}`;
  }

  if (kind === 'receive') {
    return 'receive() external payable';
  }

  if (kind === 'fallback') {
    return `fallback() external${node.stateMutability === 'payable' ? ' payable' : ''}`;
  }

  const vis = node.visibility;
  const mut = node.stateMutability;
  const parts: string[] = [vis];
  if (mut !== 'nonpayable') parts.push(mut);
  if (node.virtual) parts.push('virtual');

  const returnStr = returns ? ` returns (${returns})` : '';
  return `${parts.join(' ')} function ${node.name}(${params})${returnStr}`;
}

function extractTypeName(node: AstNode, content: string): string {
  if (!node) return 'unknown';

  if (isElementaryTypeName(node)) {
    return node.name!;
  }

  if (isUserDefinedTypeName(node)) {
    return node.name ?? (node as any).pathNode?.name ?? 'unknown';
  }

  if (isMapping(node)) {
    const key = extractTypeName(node.keyType as AstNode, content);
    const value = extractTypeName(node.valueType as AstNode, content);
    return `mapping(${key} => ${value})`;
  }

  if (isArrayTypeName(node)) {
    const base = extractTypeName(node.baseType as AstNode, content);
    return `${base}[]`;
  }

  // Fallback: try to extract from typeDescriptions
  const typeDesc = node.typeDescriptions as { typeString?: string } | undefined;
  if (typeDesc?.typeString) {
    return typeDesc.typeString;
  }

  return node.name ?? 'unknown';
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
    } else if (line.startsWith('@title')) {
      parts.push(line.replace('@title', '').trim());
    } else if (line.startsWith('@author')) {
      parts.push(line.replace('@author', '').trim());
    } else {
      parts.push(line);
    }
  }

  return parts.join('\n');
}

function findNodeById(ast: AstNode, id: number): AstNode | null {
  let found: AstNode | null = null;

  const walk = (node: AstNode) => {
    if (found) return;
    if (node.id === id) {
      found = node;
      return;
    }
    if (node.nodes) {
      for (const child of node.nodes) {
        walk(child);
      }
    }
    if (node.body && typeof node.body === 'object' && 'nodeType' in node.body) {
      walk(node.body as AstNode);
    }
    if (Array.isArray(node.statements)) {
      for (const stmt of node.statements) {
        if (stmt && typeof stmt === 'object' && 'nodeType' in stmt) walk(stmt as AstNode);
      }
    }
    if (Array.isArray(node.parameters)) {
      for (const p of node.parameters) {
        if (p && typeof p === 'object' && 'nodeType' in p) walk(p as AstNode);
      }
    }
    if (node.expression && typeof node.expression === 'object' && 'nodeType' in node.expression) {
      walk(node.expression as AstNode);
    }
    if (node.subExpression && typeof node.subExpression === 'object' && 'nodeType' in node.subExpression) {
      walk(node.subExpression as AstNode);
    }
    if (node.typeName && typeof node.typeName === 'object' && 'nodeType' in node.typeName) {
      walk(node.typeName as AstNode);
    }
  };

  walk(ast);
  return found;
}

function findDefinitionByName(ast: AstNode, name: string): AstNode | null {
  let found: AstNode | null = null;

  const walk = (node: AstNode) => {
    if (found) return;

    if (
      node.name === name &&
      (isContractDefinition(node) ||
        isFunctionDefinition(node) ||
        isStateVariableDeclaration(node) ||
        isStructDefinition(node) ||
        isEnumDefinition(node) ||
        isEventDefinition(node) ||
        isErrorDefinition(node) ||
        isModifierDefinition(node))
    ) {
      found = node;
      return;
    }

    if (node.nodes) {
      for (const child of node.nodes) {
        walk(child);
      }
    }
  };

  walk(ast);
  return found;
}

function getSolidityTypeDescription(name: string): string {
  const descriptions: Record<string, string> = {
    uint: 'Unsigned integer (256 bits)',
    uint8: 'Unsigned integer (8 bits)',
    uint16: 'Unsigned integer (16 bits)',
    uint32: 'Unsigned integer (32 bits)',
    uint64: 'Unsigned integer (64 bits)',
    uint128: 'Unsigned integer (128 bits)',
    uint256: 'Unsigned integer (256 bits)',
    int: 'Signed integer (256 bits)',
    int8: 'Signed integer (8 bits)',
    int16: 'Signed integer (16 bits)',
    int32: 'Signed integer (32 bits)',
    int64: 'Signed integer (64 bits)',
    int128: 'Signed integer (128 bits)',
    int256: 'Signed integer (256 bits)',
    address: '160-bit address',
    bool: 'Boolean (true/false)',
    string: 'Dynamic-length string',
    bytes: 'Dynamic-length byte array',
    bytes1: 'Fixed-size byte array (1 byte)',
    bytes32: 'Fixed-size byte array (32 bytes)',
    bytes4: 'Fixed-size byte array (4 bytes)',
    byte: 'Single byte (alias for bytes1)',
    fixed: 'Fixed-point number',
    ufixed: 'Unsigned fixed-point number',
  };

  return descriptions[name] ?? `${name} type`;
}

function findImportForSymbol(ast: AstNode, symbolName: string): string | null {
  let result: string | null = null;

  const walk = (node: AstNode) => {
    if (result) return;
    if (isImportDirective(node) && node.symbolAliases) {
      for (const alias of node.symbolAliases) {
        const foreign = alias.foreign as unknown as { name?: string };
        if (foreign?.name === symbolName) {
          result = node.file || null;
          return;
        }
      }
    }
    if (node.nodes) {
      for (const child of node.nodes) walk(child);
    }
  };

  walk(ast);
  return result;
}

function resolveTypeName(
  typeNameNode: AstNode,
  ast: AstNode,
  content: string,
  range: ReturnType<typeof srcToRange>
): Hover | null {
  const name = typeNameNode.name;
  if (!name) return null;

  // Try to find in current file
  const def = findDefinitionByName(ast, name);
  if (def) {
    if (isContractDefinition(def)) return hoverContract(def, range);
    if (isStructDefinition(def) || isEnumDefinition(def))
      return hoverTypeDefinition(def, content, range);
    if (isEnumDefinition(def)) return hoverTypeDefinition(def, content, range);
  }

  // Check if it's an imported type
  const importPath = findImportForSymbol(ast, name);
  if (importPath) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `\`${name}\` from \`${importPath}\``,
      },
      range: range ?? undefined,
    };
  }

  // Fallback: just show the type name
  return {
    contents: { kind: MarkupKind.Markdown, value: `\`${name}\`` },
    range: range ?? undefined,
  };
}
