import { Position, Range } from 'vscode-languageserver';
import { AstNode } from './types';

export function offsetToPosition(
  content: string,
  offset: number
): Position {
  let line = 0;
  let character = 0;

  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
  }

  return { line, character };
}

export function srcToRange(src: string, content: string): Range | null {
  const parts = src.split(':');
  if (parts.length < 2) return null;

  const start = parseInt(parts[0], 10);
  const length = parseInt(parts[1], 10);

  if (isNaN(start) || isNaN(length)) return null;

  return {
    start: offsetToPosition(content, start),
    end: offsetToPosition(content, start + length),
  };
}

export function parseSrc(src: string): { start: number; length: number } | null {
  const parts = src.split(':');
  if (parts.length < 2) return null;

  const start = parseInt(parts[0], 10);
  const length = parseInt(parts[1], 10);

  if (isNaN(start) || isNaN(length)) return null;

  return { start, length };
}

export function positionToOffset(content: string, position: Position): number {
  let offset = 0;
  let line = 0;

  for (let i = 0; i < content.length; i++) {
    if (line === position.line) {
      return offset + position.character;
    }
    if (content[i] === '\n') {
      line++;
      offset = i + 1;
    }
  }

  return offset;
}

export function walkAst(
  node: AstNode,
  visitor: (node: AstNode, parent: AstNode | null) => boolean | void
): void {
  walkAstInternal(node, null, visitor);
}

function walkAstInternal(
  node: AstNode,
  parent: AstNode | null,
  visitor: (node: AstNode, parent: AstNode | null) => boolean | void
): void {
  const result = visitor(node, parent);
  if (result === false) return;

  if (node.nodes) {
    for (const child of node.nodes) {
      walkAstInternal(child, node, visitor);
    }
  }

  if (nodeTypeHasChildren(node)) {
    for (const child of getChildren(node)) {
      if (child && typeof child === 'object' && 'nodeType' in child) {
        walkAstInternal(child as AstNode, node, visitor);
      }
    }
  }
}

function nodeTypeHasChildren(node: AstNode): boolean {
  const t = node.nodeType;
  return (
    t === 'Block' ||
    t === 'ParameterList' ||
    t === 'InheritanceSpecifier' ||
    t === 'OverrideSpecifier' ||
    t === 'FunctionCall' ||
    t === 'MemberAccess' ||
    t === 'Mapping' ||
    t === 'ArrayTypeName' ||
    t === 'UserDefinedTypeName' ||
    t === 'StateVariableDeclaration' ||
    t === 'VariableDeclaration' ||
    t === 'StructDefinition' ||
    t === 'EnumDefinition' ||
    t === 'EventDefinition' ||
    t === 'ErrorDefinition' ||
    t === 'ModifierDefinition' ||
    t === 'ContractDefinition' ||
    t === 'FunctionDefinition' ||
    t === 'ImportDirective' ||
    t === 'SourceUnit'
  );
}

function getChildren(node: AstNode): AstNode[] {
  const children: AstNode[] = [];

  if (node.body && typeof node.body === 'object' && 'nodeType' in node.body) {
    children.push(node.body as unknown as AstNode);
  }
  if (node.parameters && typeof node.parameters === 'object' && 'nodeType' in node.parameters) {
    children.push(node.parameters as unknown as AstNode);
  }
  if (node.returnParameters && typeof node.returnParameters === 'object' && 'nodeType' in node.returnParameters) {
    children.push(node.returnParameters as unknown as AstNode);
  }
  if (node.typeName && typeof node.typeName === 'object' && 'nodeType' in node.typeName) {
    children.push(node.typeName as unknown as AstNode);
  }
  if (node.keyType && typeof node.keyType === 'object' && 'nodeType' in node.keyType) {
    children.push(node.keyType as unknown as AstNode);
  }
  if (node.valueType && typeof node.valueType === 'object' && 'nodeType' in node.valueType) {
    children.push(node.valueType as unknown as AstNode);
  }
  if (node.baseType && typeof node.baseType === 'object' && 'nodeType' in node.baseType) {
    children.push(node.baseType as unknown as AstNode);
  }
  if (node.expression && typeof node.expression === 'object' && 'nodeType' in node.expression) {
    children.push(node.expression as unknown as AstNode);
  }
  if (node.baseName && typeof node.baseName === 'object' && 'nodeType' in node.baseName) {
    children.push(node.baseName as unknown as AstNode);
  }
  if (node.pathNode && typeof node.pathNode === 'object' && 'nodeType' in node.pathNode) {
    children.push(node.pathNode as unknown as AstNode);
  }
  if (Array.isArray(node.arguments)) {
    for (const arg of node.arguments) {
      if (arg && typeof arg === 'object' && 'nodeType' in arg) {
        children.push(arg as AstNode);
      }
    }
  }
  if (Array.isArray(node.members)) {
    for (const member of node.members) {
      if (member && typeof member === 'object' && 'nodeType' in member) {
        children.push(member as AstNode);
      }
    }
  }
  if (Array.isArray(node.baseContracts)) {
    for (const base of node.baseContracts) {
      if (base && typeof base === 'object' && 'nodeType' in base) {
        children.push(base as AstNode);
      }
    }
  }
  if (Array.isArray(node.overrides)) {
    for (const override of node.overrides) {
      if (override && typeof override === 'object' && 'nodeType' in override) {
        children.push(override as AstNode);
      }
    }
  }
  if (Array.isArray(node.statements)) {
    for (const stmt of node.statements) {
      if (stmt && typeof stmt === 'object' && 'nodeType' in stmt) {
        children.push(stmt as AstNode);
      }
    }
  }
  if (Array.isArray(node.symbolAliases)) {
    for (const alias of node.symbolAliases) {
      if (alias?.local && typeof alias.local === 'object' && 'nodeType' in alias.local) {
        children.push(alias.local as unknown as AstNode);
      }
      if (alias?.foreign && typeof alias.foreign === 'object' && 'nodeType' in alias.foreign) {
        children.push(alias.foreign as unknown as AstNode);
      }
    }
  }

  return children;
}

export function findNodeAtPosition(
  ast: AstNode,
  content: string,
  position: Position
): AstNode | null {
  const offset = positionToOffset(content, position);
  let best: AstNode | null = null;

  walkAst(ast, (node) => {
    if (!node.src) return;

    const parsed = parseSrc(node.src);
    if (!parsed) return;

    if (offset >= parsed.start && offset <= parsed.start + parsed.length) {
      best = node;
    }
  });

  return best;
}

export function findNodeAtOffset(ast: AstNode, offset: number): AstNode | null {
  let best: AstNode | null = null;

  walkAst(ast, (node) => {
    if (!node.src) return;

    const parsed = parseSrc(node.src);
    if (!parsed) return;

    if (offset >= parsed.start && offset <= parsed.start + parsed.length) {
      best = node;
    }
  });

  return best;
}

export function flattenAst(ast: AstNode): AstNode[] {
  const nodes: AstNode[] = [];

  walkAst(ast, (node) => {
    nodes.push(node);
  });

  return nodes;
}

export function findNodesByName(
  ast: AstNode,
  name: string,
  nodeType?: string
): AstNode[] {
  const results: AstNode[] = [];

  walkAst(ast, (node) => {
    if (node.name === name && (!nodeType || node.nodeType === nodeType)) {
      results.push(node);
    }
  });

  return results;
}

export function findContracts(ast: AstNode): AstNode[] {
  return findNodesByName(ast, '', 'ContractDefinition').filter(
    (n) => n.name
  );
}

export function findFunctions(ast: AstNode): AstNode[] {
  return findNodesByName(ast, '', 'FunctionDefinition').filter(
    (n) => n.name && (n as AstNode).name !== ''
  );
}

export function findStateVariables(ast: AstNode): AstNode[] {
  return findNodesByName(ast, '', 'StateVariableDeclaration');
}

export function findImports(ast: AstNode): AstNode[] {
  return findNodesByName(ast, '', 'ImportDirective');
}
