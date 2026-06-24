export interface AstNode {
  id: number;
  nodeType: string;
  src: string;
  name?: string;
  nodes?: AstNode[];
  [key: string]: unknown;
}

export interface SourceUnit extends AstNode {
  nodeType: 'SourceUnit';
  nodes: AstNode[];
  license?: string;
}

export interface ContractDefinition extends AstNode {
  nodeType: 'ContractDefinition';
  name: string;
  contractKind: 'interface' | 'library' | 'contract';
  abstract?: boolean;
  fullyImplemented?: boolean;
  nodes: AstNode[];
  baseContracts?: InheritanceSpecifier[];
  documentation?: Documentation;
}

export interface InheritanceSpecifier extends AstNode {
  nodeType: 'InheritanceSpecifier';
  baseName: TypeName;
  arguments?: FunctionCall;
}

export interface FunctionDefinition extends AstNode {
  nodeType: 'FunctionDefinition';
  name: string;
  kind: 'function' | 'constructor' | 'receive' | 'fallback';
  visibility: 'public' | 'internal' | 'private' | 'external';
  stateMutability: 'pure' | 'view' | 'payable' | 'nonpayable';
  virtual?: boolean;
  overrides?: OverrideSpecifier;
  parameters: ParameterList;
  returnParameters?: ParameterList;
  body?: Block;
  documentation?: Documentation;
}

export interface StateVariableDeclaration extends AstNode {
  nodeType: 'StateVariableDeclaration';
  name: string;
  typeName: TypeName;
  visibility: 'public' | 'internal' | 'private';
  constant?: boolean;
  immutable?: boolean;
  documentation?: Documentation;
}

export interface VariableDeclaration extends AstNode {
  nodeType: 'VariableDeclaration';
  name: string;
  typeName: TypeName;
  storageLocation?: 'default' | 'memory' | 'storage' | 'calldata';
}

export interface StructDefinition extends AstNode {
  nodeType: 'StructDefinition';
  name: string;
  members: VariableDeclaration[];
}

export interface EnumDefinition extends AstNode {
  nodeType: 'EnumDefinition';
  name: string;
  values: EnumValue[];
}

export interface EnumValue extends AstNode {
  nodeType: 'EnumValue';
  name: string;
}

export interface EventDefinition extends AstNode {
  nodeType: 'EventDefinition';
  name: string;
  parameters: ParameterList;
  anonymous?: boolean;
  documentation?: Documentation;
}

export interface ErrorDefinition extends AstNode {
  nodeType: 'ErrorDefinition';
  name: string;
  parameters: ParameterList;
}

export interface ModifierDefinition extends AstNode {
  nodeType: 'ModifierDefinition';
  name: string;
  visibility: 'public' | 'internal' | 'private';
  parameters?: ParameterList;
  body?: Block;
  virtual?: boolean;
  documentation?: Documentation;
}

export interface ImportDirective extends AstNode {
  nodeType: 'ImportDirective';
  file: string;
  symbolAliases?: { local: Identifier; foreign: Identifier }[];
  unitAlias?: string;
}

export interface ParameterList extends AstNode {
  nodeType: 'ParameterList';
  parameters: VariableDeclaration[];
}

export interface Block extends AstNode {
  nodeType: 'Block';
  statements: AstNode[];
}

export interface ElementaryTypeName extends AstNode {
  nodeType: 'ElementaryTypeName';
  name: string;
  typeDescriptions?: TypeDescriptions;
}

export interface UserDefinedTypeName extends AstNode {
  nodeType: 'UserDefinedTypeName';
  name: string;
  pathNode?: Identifier;
  typeDescriptions?: TypeDescriptions;
}

export interface Mapping extends AstNode {
  nodeType: 'Mapping';
  keyType: TypeName;
  valueType: TypeName;
  typeDescriptions?: TypeDescriptions;
}

export interface ArrayTypeName extends AstNode {
  nodeType: 'ArrayTypeName';
  baseType: TypeName;
  length?: AstNode;
  typeDescriptions?: TypeDescriptions;
}

export interface FunctionCall extends AstNode {
  nodeType: 'FunctionCall';
  expression: AstNode;
  arguments: AstNode[];
  names: string[];
}

export interface MemberAccess extends AstNode {
  nodeType: 'MemberAccess';
  expression: AstNode;
  memberName: string;
  typeDescriptions?: TypeDescriptions;
}

export interface Identifier extends AstNode {
  nodeType: 'Identifier';
  name: string;
  referencedDeclaration?: number;
  typeDescriptions?: TypeDescriptions;
}

export interface OverrideSpecifier extends AstNode {
  nodeType: 'OverrideSpecifier';
  overrides: AstNode[];
}

export interface Documentation extends AstNode {
  nodeType: 'StructuredDocumentation' | 'NatSpec';
  text: string;
}

export interface TypeDescriptions {
  typeString?: string;
  typeIdentifier?: string;
}

export type TypeName =
  | ElementaryTypeName
  | UserDefinedTypeName
  | Mapping
  | ArrayTypeName
  | FunctionDefinition;

export function isSourceUnit(node: AstNode): node is SourceUnit {
  return node.nodeType === 'SourceUnit';
}

export function isContractDefinition(node: AstNode): node is ContractDefinition {
  return node.nodeType === 'ContractDefinition';
}

export function isFunctionDefinition(node: AstNode): node is FunctionDefinition {
  return node.nodeType === 'FunctionDefinition';
}

export function isStateVariableDeclaration(
  node: AstNode
): node is StateVariableDeclaration {
  return node.nodeType === 'StateVariableDeclaration';
}

export function isStructDefinition(node: AstNode): node is StructDefinition {
  return node.nodeType === 'StructDefinition';
}

export function isEnumDefinition(node: AstNode): node is EnumDefinition {
  return node.nodeType === 'EnumDefinition';
}

export function isEventDefinition(node: AstNode): node is EventDefinition {
  return node.nodeType === 'EventDefinition';
}

export function isErrorDefinition(node: AstNode): node is ErrorDefinition {
  return node.nodeType === 'ErrorDefinition';
}

export function isModifierDefinition(
  node: AstNode
): node is ModifierDefinition {
  return node.nodeType === 'ModifierDefinition';
}

export function isImportDirective(node: AstNode): node is ImportDirective {
  return node.nodeType === 'ImportDirective';
}

export function isVariableDeclaration(
  node: AstNode
): node is VariableDeclaration {
  return node.nodeType === 'VariableDeclaration';
}

export function isIdentifier(node: AstNode): node is Identifier {
  return node.nodeType === 'Identifier';
}

export function isMemberAccess(node: AstNode): node is MemberAccess {
  return node.nodeType === 'MemberAccess';
}

export function isFunctionCall(node: AstNode): node is FunctionCall {
  return node.nodeType === 'FunctionCall';
}

export function isUserDefinedTypeName(
  node: AstNode
): node is UserDefinedTypeName {
  return node.nodeType === 'UserDefinedTypeName';
}

export function isElementaryTypeName(
  node: AstNode
): node is ElementaryTypeName {
  return node.nodeType === 'ElementaryTypeName';
}

export function isMapping(node: AstNode): node is Mapping {
  return node.nodeType === 'Mapping';
}

export function isArrayTypeName(node: AstNode): node is ArrayTypeName {
  return node.nodeType === 'ArrayTypeName';
}

export function isEnumValue(node: AstNode): node is EnumValue {
  return node.nodeType === 'EnumValue';
}

export function isInheritanceSpecifier(
  node: AstNode
): node is InheritanceSpecifier {
  return node.nodeType === 'InheritanceSpecifier';
}
