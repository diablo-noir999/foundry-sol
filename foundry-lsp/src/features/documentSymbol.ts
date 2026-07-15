import {
  DocumentSymbol,
  SymbolKind,
  Range,
} from 'vscode-languageserver';
import {
  AstNode,
  isContractDefinition,
  isFunctionDefinition,
  isStateVariableDeclaration,
  isStructDefinition,
  isEnumDefinition,
  isEventDefinition,
  isErrorDefinition,
  isModifierDefinition,
} from '../ast/types';
import { walkAst, srcToRange } from '../ast/traversal';

const EMPTY_RANGE = Range.create(0, 0, 0, 0);

function safeRange(src: string | undefined, content: string): Range {
  if (!src) return EMPTY_RANGE;
  return srcToRange(src, content) ?? EMPTY_RANGE;
}

export function provideDocumentSymbols(
  ast: AstNode,
  content: string
): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];

  walkAst(ast, (node) => {
    // Only process top-level and contract-level definitions
    if (isContractDefinition(node)) {
      symbols.push(createContractSymbol(node, content));
      return false; // Don't walk into contract children here — we do it manually
    }

    if (isFunctionDefinition(node)) {
      const sym = createFunctionSymbol(node, content);
      if (sym) symbols.push(sym);
    } else if (isStateVariableDeclaration(node)) {
      const sym = createVariableSymbol(node, content);
      if (sym) symbols.push(sym);
    } else if (isStructDefinition(node)) {
      const sym = createTypeSymbol(node, content, SymbolKind.Struct);
      if (sym) symbols.push(sym);
    } else if (isEnumDefinition(node)) {
      const sym = createTypeSymbol(node, content, SymbolKind.Enum);
      if (sym) symbols.push(sym);
    } else if (isEventDefinition(node)) {
      const sym = createEventSymbol(node, content);
      if (sym) symbols.push(sym);
    } else if (isErrorDefinition(node)) {
      const sym = createErrorSymbol(node, content);
      if (sym) symbols.push(sym);
    } else if (isModifierDefinition(node)) {
      const sym = createModifierSymbol(node, content);
      if (sym) symbols.push(sym);
    } else if ((node as any).nodeType === 'UserDefinedValueTypeDefinition') {
      const sym = createTypeSymbol(node, content, SymbolKind.TypeParameter);
      if (sym) symbols.push(sym);
    }

    return true;
  });

  return symbols;
}

function createContractSymbol(node: AstNode, content: string): DocumentSymbol {
  const range = safeRange(node.src, content);
  const kind = getContractSymbolKind(node);
  const children: DocumentSymbol[] = [];

  // Walk contract members
  if (node.nodes) {
    for (const child of node.nodes) {
      const sym = nodeToSymbol(child, content);
      if (sym) children.push(sym);
    }
  }

  return {
    name: node.name ?? '<anonymous>',
    kind,
    range,
    selectionRange: range,
    children,
  };
}

function getContractSymbolKind(node: AstNode): SymbolKind {
  const contractKind = (node as any).contractKind;
  if (contractKind === 'interface') return SymbolKind.Interface;
  if (contractKind === 'library') return SymbolKind.Module;
  return SymbolKind.Class;
}

function nodeToSymbol(node: AstNode, content: string): DocumentSymbol | null {
  if (isFunctionDefinition(node)) return createFunctionSymbol(node, content);
  if (isStateVariableDeclaration(node)) {
    if ((node as any).constant) {
      return createConstantSymbol(node, content);
    }
    return createVariableSymbol(node, content);
  }
  if (isStructDefinition(node)) return createTypeSymbol(node, content, SymbolKind.Struct);
  if (isEnumDefinition(node)) return createTypeSymbol(node, content, SymbolKind.Enum);
  if ((node as any).nodeType === 'UserDefinedValueTypeDefinition') {
    return createTypeSymbol(node, content, SymbolKind.TypeParameter);
  }
  if (isEventDefinition(node)) return createEventSymbol(node, content);
  if (isErrorDefinition(node)) return createErrorSymbol(node, content);
  if (isModifierDefinition(node)) return createModifierSymbol(node, content);
  return null;
}

function createFunctionSymbol(node: AstNode, content: string): DocumentSymbol | null {
  const kind = (node as any).kind;
  const name = kind === 'constructor' ? 'constructor' : node.name;
  if (!name) return null;
  const range = safeRange(node.src, content);
  const symbolKind = getFunctionSymbolKind(node);

  // Collect input parameters and return parameters as children
  const children: DocumentSymbol[] = [];
  const params = (node as any).parameters;
  if (params?.parameters) {
    for (const param of params.parameters) {
      if (param.name) {
        children.push({
          name: param.name,
          kind: SymbolKind.Variable,
          range: safeRange(param.src, content),
          selectionRange: safeRange(param.src, content),
        });
      }
    }
  }
  const returnParams = (node as any).returnParameters;
  if (returnParams?.parameters) {
    for (const param of returnParams.parameters) {
      if (param.name) {
        children.push({
          name: param.name,
          kind: SymbolKind.Variable,
          range: safeRange(param.src, content),
          selectionRange: safeRange(param.src, content),
        });
      }
    }
  }

  return {
    name,
    kind: symbolKind,
    range,
    selectionRange: range,
    children: children.length > 0 ? children : undefined,
  };
}

function getFunctionSymbolKind(node: AstNode): SymbolKind {
  const kind = (node as any).kind;
  if (kind === 'constructor') return SymbolKind.Constructor;
  if (kind === 'receive' || kind === 'fallback') return SymbolKind.Event;
  return SymbolKind.Function;
}

function createVariableSymbol(node: AstNode, content: string): DocumentSymbol | null {
  if (!node.name) return null;
  const range = safeRange(node.src, content);

  return {
    name: node.name,
    kind: SymbolKind.Variable,
    range,
    selectionRange: range,
  };
}

function createConstantSymbol(node: AstNode, content: string): DocumentSymbol | null {
  if (!node.name) return null;
  const range = safeRange(node.src, content);

  return {
    name: node.name,
    kind: SymbolKind.Constant,
    range,
    selectionRange: range,
  };
}

function createTypeSymbol(
  node: AstNode,
  content: string,
  kind: SymbolKind
): DocumentSymbol | null {
  if (!node.name) return null;
  const range = safeRange(node.src, content);

  // 11.5: Struct members as children
  const children: DocumentSymbol[] = [];
  if (isStructDefinition(node)) {
    const members = (node as any).members ?? [];
    for (const member of members) {
      if (member.name) {
        children.push({
          name: member.name,
          kind: SymbolKind.Field,
          range: safeRange(member.src, content),
          selectionRange: safeRange(member.src, content),
        });
      }
    }
  }

  // 11.14: UDVT
  if ((node as any).nodeType === 'UserDefinedValueTypeDefinition') {
    kind = SymbolKind.TypeParameter;
  }

  return {
    name: node.name,
    kind,
    range,
    selectionRange: range,
    children: children.length > 0 ? children : undefined,
  };
}

function createEventSymbol(node: AstNode, content: string): DocumentSymbol | null {
  if (!node.name) return null;
  const range = safeRange(node.src, content);

  return {
    name: node.name,
    kind: SymbolKind.Event,
    range,
    selectionRange: range,
  };
}

function createErrorSymbol(node: AstNode, content: string): DocumentSymbol | null {
  if (!node.name) return null;
  const range = safeRange(node.src, content);

  return {
    name: node.name,
    kind: SymbolKind.Event,
    range,
    selectionRange: range,
  };
}

function createModifierSymbol(node: AstNode, content: string): DocumentSymbol | null {
  if (!node.name) return null;
  const range = safeRange(node.src, content);

  return {
    name: node.name,
    kind: SymbolKind.Function,
    range,
    selectionRange: range,
  };
}
