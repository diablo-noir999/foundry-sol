import {
  SemanticTokens,
  SemanticTokensBuilder,
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
  isImportDirective,
  isElementaryTypeName,
  isUserDefinedTypeName,
  isIdentifier,
  isMemberAccess,
  isFunctionCall,
  isMapping,
  isArrayTypeName,
  isVariableDeclaration,
  isEnumValue,
  isInheritanceSpecifier,
} from '../ast/types';
import { walkAst, offsetToPosition, parseSrc } from '../ast/traversal';

// Legend indices (must match capabilities.ts)
const T = {
  namespace: 0,
  type: 1,
  class: 2,
  enum: 3,
  interface: 4,
  struct: 5,
  typeParameter: 6,
  parameter: 7,
  variable: 8,
  property: 9,
  enumMember: 10,
  event: 11,
  function: 12,
  method: 13,
  constructor: 14,
  string: 15,
  number: 16,
  regexp: 17,
  operator: 18,
  keyword: 19,
  comment: 20,
  modifier: 21,
  decorator: 22,
};

const M = {
  declaration: 1 << 0,
  definition: 1 << 1,
  readonly: 1 << 2,
  static: 1 << 3,
  deprecated: 1 << 4,
  abstract: 1 << 5,
  async: 1 << 6,
  modification: 1 << 7,
  documentation: 1 << 8,
  defaultLibrary: 1 << 9,
};

export function provideSemanticTokens(
  ast: AstNode,
  content: string
): SemanticTokens {
  const builder = new SemanticTokensBuilder();

  // Emit semantic tokens for AST nodes
  walkAst(ast, (node) => {
    const token = nodeToSemanticToken(node, content);
    if (token) {
      builder.push(token.line, token.character, token.length, token.type, token.modifiers);
    }
    return true;
  });

  // Emit comment tokens by scanning source text (comments aren't in the AST)
  emitCommentTokens(content, builder);

  return builder.build();
}

interface TokenInfo {
  line: number;
  character: number;
  length: number;
  type: number;
  modifiers: number;
}

function nodeToSemanticToken(node: AstNode, content: string): TokenInfo | null {
  if (!node.src) return null;

  const parsed = parseSrc(node.src);
  if (!parsed) return null;

  const pos = offsetToPosition(content, parsed.start);
  const name = node.name;

  if (isContractDefinition(node)) {
    const kind = (node as any).contractKind;
    const type = kind === 'interface' ? T.interface : T.class;
    const isAbstract = (node as any).abstract === true;
    return { line: pos.line, character: pos.character, length: name?.length ?? parsed.length, type, modifiers: isAbstract ? M.abstract : 0 };
  }

  if (isFunctionDefinition(node)) {
    const kind = (node as any).kind;
    if (kind === 'constructor') {
      return { line: pos.line, character: pos.character, length: name?.length ?? 11, type: T.constructor, modifiers: 0 };
    }
    const isVirtual = (node as any).virtual === true;
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.function, modifiers: isVirtual ? M.abstract : 0 };
  }

  if (isStateVariableDeclaration(node)) {
    const isReadonly = (node as any).constant === true || (node as any).immutable === true;
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.variable, modifiers: M.definition | (isReadonly ? M.readonly : 0) };
  }

  if (isStructDefinition(node)) {
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.struct, modifiers: M.definition };
  }

  if (isEnumDefinition(node)) {
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.enum, modifiers: M.definition };
  }

  if (isEventDefinition(node)) {
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.event, modifiers: 0 };
  }

  if (isErrorDefinition(node)) {
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.type, modifiers: 0 };
  }

  if (isModifierDefinition(node)) {
    const isVirtual = (node as any).virtual === true;
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.function, modifiers: M.definition | (isVirtual ? M.abstract : 0) };
  }

  if (isImportDirective(node)) {
    return { line: pos.line, character: pos.character, length: 6, type: T.keyword, modifiers: 0 };
  }

  if (isVariableDeclaration(node)) {
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.parameter, modifiers: M.definition };
  }

  if (isEnumValue(node)) {
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.enumMember, modifiers: M.definition };
  }

  if (isInheritanceSpecifier(node)) {
    const baseName = (node as any).baseName;
    if (baseName?.name) {
      const typeOffset = content.indexOf(baseName.name, parsed.start);
      if (typeOffset >= 0) {
        const typePos = offsetToPosition(content, typeOffset);
        return { line: typePos.line, character: typePos.character, length: baseName.name.length, type: T.type, modifiers: 0 };
      }
    }
  }

  if (isElementaryTypeName(node) || isUserDefinedTypeName(node)) {
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.type, modifiers: 0 };
  }

  if (isIdentifier(node)) {
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.variable, modifiers: 0 };
  }

  if (isMemberAccess(node)) {
    const memberName = (node as any).memberName;
    if (memberName) {
      const memberOffset = content.indexOf(memberName, parsed.start);
      if (memberOffset >= 0) {
        const memberPos = offsetToPosition(content, memberOffset);
        return { line: memberPos.line, character: memberPos.character, length: memberName.length, type: T.property, modifiers: 0 };
      }
    }
  }

  if (isFunctionCall(node)) {
    const expr = (node as any).expression;
    if (expr?.name) {
      const callOffset = content.indexOf(expr.name, parsed.start);
      if (callOffset >= 0) {
        const callPos = offsetToPosition(content, callOffset);
        return { line: callPos.line, character: callPos.character, length: expr.name.length, type: T.function, modifiers: 0 };
      }
    }
  }

  if (isMapping(node)) {
    return { line: pos.line, character: pos.character, length: 7, type: T.type, modifiers: 0 };
  }

  if (isArrayTypeName(node)) {
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.type, modifiers: 0 };
  }

  // 11.13: UserDefinedValueType
  if ((node as any).nodeType === 'UserDefinedValueTypeDefinition') {
    return { line: pos.line, character: pos.character, length: name?.length ?? 0, type: T.type, modifiers: M.definition };
  }

  // 11.14: Literal nodes — string literals, number literals, hex literals
  if ((node as any).nodeType === 'Literal') {
    const value = (node as any).value as string | undefined;
    const kind = (node as any).kind as string | undefined;

    // String literals: "string" kind or value starts with quote
    if (kind === 'string' || (typeof value === 'string' && value.startsWith('"'))) {
      // Use src length for the token
      return { line: pos.line, character: pos.character, length: parsed.length, type: T.string, modifiers: 0 };
    }

    // Number literals: "number" kind or value is purely numeric
    if (kind === 'number' || (typeof value === 'string' && /^\d/.test(value))) {
      return { line: pos.line, character: pos.character, length: parsed.length, type: T.number, modifiers: 0 };
    }

    // Hex literals: "hex" kind or hex string
    if (kind === 'hex' || (typeof value === 'string' && /^0x/i.test(value))) {
      return { line: pos.line, character: pos.character, length: parsed.length, type: T.number, modifiers: 0 };
    }

    // Boolean literals
    if (kind === 'bool' || value === 'true' || value === 'false') {
      return { line: pos.line, character: pos.character, length: parsed.length, type: T.keyword, modifiers: 0 };
    }
  }

  return null;
}

function emitCommentTokens(content: string, builder: SemanticTokensBuilder): void {
  const lines = content.split('\n');
  let inBlockComment = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    let i = 0;

    while (i < line.length) {
      // Inside a block comment — find the end
      if (inBlockComment) {
        const endIdx = line.indexOf('*/', i);
        if (endIdx >= 0) {
          const commentLength = endIdx + 2 - i;
          builder.push(lineIdx, i, commentLength, T.comment, 0);
          inBlockComment = false;
          i = endIdx + 2;
        } else {
          // Rest of line is comment
          builder.push(lineIdx, i, line.length - i, T.comment, 0);
          i = line.length;
        }
        continue;
      }

      const ch = line[i];

      // Single-line comment: //
      if (ch === '/' && i + 1 < line.length && line[i + 1] === '/') {
        builder.push(lineIdx, i, line.length - i, T.comment, 0);
        break; // Rest of line is comment
      }

      // Multi-line comment start: /*
      if (ch === '/' && i + 1 < line.length && line[i + 1] === '*') {
        const endIdx = line.indexOf('*/', i + 2);
        if (endIdx >= 0) {
          const commentLength = endIdx + 2 - i;
          builder.push(lineIdx, i, commentLength, T.comment, 0);
          i = endIdx + 2;
        } else {
          // Multi-line comment continues to next lines
          builder.push(lineIdx, i, line.length - i, T.comment, 0);
          inBlockComment = true;
          i = line.length;
        }
        continue;
      }

      i++;
    }
  }
}
