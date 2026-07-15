import {
  CodeAction,
  CodeActionKind,
  Diagnostic,
  DiagnosticSeverity,
  Range,
  TextEdit,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  AstNode,
  ContractDefinition,
  isContractDefinition,
} from '../ast/types';
import { CompileResult } from '../compiler/cache';

// ─── Compiler Diagnostic Registry ───────────────────────────────────────────
// Each entry maps a solc error code to a quickfix handler and a list of
// error codes that this handler supersedes at the same location.
// Modeled after hardhat-vscode's `compilerDiagnostics` registry pattern.

interface CompilerDiagnosticHandler {
  /** Solc error code, e.g. "1878" */
  code: string;
  /** Error codes blocked by this handler at the same file+location.
   *  E.g. "abstract" blocks "override" because fixing abstract subsumes it. */
  blocks: string[];
  /** Produce code actions for this diagnostic */
  resolve: (diag: Diagnostic, document: TextDocument, allDiagnostics: Diagnostic[]) => CodeAction[];
}

const compilerDiagnostics: Record<string, CompilerDiagnosticHandler> = {};

function register(handler: CompilerDiagnosticHandler): void {
  compilerDiagnostics[handler.code] = handler;
}

// ─── Handler: 1878 — Missing SPDX license identifier ───
register({
  code: '1878',
  blocks: [],
  resolve(diag, document) {
    return [createInsertAction(document, diag, 'Add SPDX-License-Identifier: MIT',
      { line: 0, character: 0 }, '// SPDX-License-Identifier: MIT\n')];
  },
});

// ─── Handler: 4937 — Missing visibility specifier ───
register({
  code: '4937',
  blocks: [],
  resolve(diag, document) {
    const line = diag.range.start.line;
    const lineText = document.getText({
      start: { line, character: 0 },
      end: { line: line + 1, character: 0 },
    });
    const match = lineText.match(/function\s+(\w+)/);
    if (match) {
      const funcName = match[1];
      const editRange = findAfterText(document, line, `function ${funcName}`);
      return [createInsertAction(document, diag, 'Add public visibility',
        editRange, ' public')];
    }
    return [];
  },
});

// ─── Handler: 9456 — Missing override specifier ───
register({
  code: '9456',
  blocks: ['4937'], // override is more specific than visibility
  resolve(diag, document) {
    const line = diag.range.start.line;
    const editRange = findAfterFunctionSig(document, line);
    return [createInsertAction(document, diag, 'Add override', editRange, ' override')];
  },
});

// ─── Handler: 5333 — Missing or wrong pragma solidity version ───
register({
  code: '5333',
  blocks: [],
  resolve(diag, document) {
    const msg = diag.message.toLowerCase();
    // Try to extract version from the error message
    const versionMatch = msg.match(/(\d+\.\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : '0.8.0';
    // Insert after SPDX license if present, otherwise at top
    const firstLine = document.getText({ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } });
    const insertLine = firstLine.includes('SPDX') ? 1 : 0;
    return [createInsertAction(document, diag, `Add pragma solidity ^${version}`,
      { line: insertLine, character: 0 }, `pragma solidity ^${version};\n`)];
  },
});

// ─── Handler: 9429 — Invalid checksum in address literal ───
register({
  code: '9429',
  blocks: [],
  resolve(diag, document) {
    // Extract the checksummed address from the error message
    const checksummedMatch = diag.message.match(/checksummed address:\s*"(\w+)"/i);
    if (checksummedMatch && checksummedMatch[1]) {
      const checksummed = checksummedMatch[1];
      return [createReplaceAction(document, diag, 'Convert to checksummed address',
        diag.range, checksummed)];
    }
    return [];
  },
});

// ─── Handler: 7407 — Missing data location ───
register({
  code: '7407',
  blocks: [],
  resolve(diag, document) {
    const editRange = findBeforeVariableName(document, diag.range.start.line);
    return [createInsertAction(document, diag, 'Add memory data location', editRange, ' memory')];
  },
});

// ─── Handler: 2519 — Contract should be marked abstract ───
register({
  code: '2519',
  blocks: ['9456', '4937', '9582'], // abstract subsumes override, visibility, virtual
  resolve(diag, document) {
    const line = diag.range.start.line;
    const editRange = findBeforeContract(document, line);
    return [createInsertAction(document, diag, 'Make contract abstract', editRange, 'abstract ')];
  },
});

// ─── Handler: 9582 — Missing virtual specifier ───
register({
  code: '9582',
  blocks: [],
  resolve(diag, document) {
    const line = diag.range.start.line;
    const editRange = findAfterFunctionSig(document, line);
    return [createInsertAction(document, diag, 'Add virtual', editRange, ' virtual')];
  },
});

// ─── Handler: 6422 — Function state mutability can be restricted ───
register({
  code: '6422',
  blocks: [],
  resolve(diag, document) {
    const line = diag.range.start.line;
    // Determine if view or pure based on message
    const msg = diag.message.toLowerCase();
    const modifier = (msg.includes('pure') && !msg.includes('view')) ? 'pure' : 'view';
    const editRange = findAfterKeyword(document, line, '{');
    return [createInsertAction(document, diag, `Make function ${modifier}`, editRange, ` ${modifier}`)];
  },
});

// ─── Exported helpers for deduplication ───

/** Get the set of error codes blocked by any registered handler at a given location */
export function getBlockedCodes(codes: string[]): Set<string> {
  const blocked = new Set<string>();
  for (const code of codes) {
    const handler = compilerDiagnostics[code];
    if (handler) {
      for (const b of handler.blocks) {
        blocked.add(b);
      }
    }
  }
  return blocked;
}

/** Check if a specific error code is registered */
export function hasRegisteredHandler(code: string): boolean {
  return code in compilerDiagnostics;
}

// ─── Error Deduplication ────────────────────────────────────────────────────

/**
 * Deduplicate compiler diagnostics by grouping them by file+location and
 * removing errors that are superseded by more specific ones.
 *
 * Modeled after hardhat-vscode's _filterBlockedErrorsWithinGroup():
 * each registered handler declares which error codes it "blocks" at the
 * same source location. When multiple errors target the same location,
 * only the ones not blocked by any other are kept.
 *
 * E.g. error 2519 (abstract) blocks 9456 (override) and 4937 (visibility),
 * so if a contract has both "should be abstract" and "missing override",
 * only the abstract error is shown.
 */
export function diagnosticDeduplicate(diagnostics: Diagnostic[]): Diagnostic[] {
  // Group by file + location range
  const groups = new Map<string, Diagnostic[]>();

  for (const diag of diagnostics) {
    const file = diag.source ?? 'unknown';
    const key = `${file}::${diag.range.start.line}:${diag.range.start.character}-${diag.range.end.line}:${diag.range.end.character}`;
    const group = groups.get(key);
    if (group) {
      group.push(diag);
    } else {
      groups.set(key, [diag]);
    }
  }

  // Filter each group: remove errors blocked by other errors in the same group
  const result: Diagnostic[] = [];
  for (const group of groups.values()) {
    // Collect all error codes present in this group
    const codesInGroup = group
      .map(d => String(d.code ?? ''))
      .filter(c => c !== '');

    // Compute which codes are blocked
    const blocked = getBlockedCodes(codesInGroup);

    // Keep only diagnostics whose code is not blocked
    for (const diag of group) {
      const code = String(diag.code ?? '');
      if (code === '' || !blocked.has(code)) {
        result.push(diag);
      }
    }
  }

  return result;
}

// ─── ERC Snippets ───────────────────────────────────────────────────────────

const ERC20_SNIPPET = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MyToken is ERC20 {
    constructor(uint256 initialSupply) ERC20("MyToken", "MTK") {
        _mint(msg.sender, initialSupply);
    }
}`;

const ERC721_SNIPPET = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MyNFT is ERC721 {
    uint256 private _nextTokenId;

    constructor() ERC721("MyNFT", "MNFT") {}

    function mint(address to) public returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _mint(to, tokenId);
        return tokenId;
    }
}`;

const ERC1155_SNIPPET = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

contract MyMultiToken is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) public {
        _mint(to, id, amount, "");
    }
}`;

const OWNABLE_SNIPPET = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

contract MyContract is Ownable {
    constructor() Ownable(msg.sender) {}
}`;

// ─── Main entry point ───────────────────────────────────────────────────────

export function provideCodeActions(
  ast: AstNode,
  document: TextDocument,
  range: Range,
  diagnostics: Diagnostic[],
  _compileResult: CompileResult
): CodeAction[] {
  const actions: CodeAction[] = [];
  const content = document.getText();
  const trimmed = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();

  // Empty file — offer contract templates
  if (trimmed === '' || trimmed === 'pragma solidity ^0.8.0;') {
    actions.push(createSnippetAction(document, 'Create ERC-20 Token', 'erc20-snippet', ERC20_SNIPPET));
    actions.push(createSnippetAction(document, 'Create ERC-721 NFT', 'erc721-snippet', ERC721_SNIPPET));
    actions.push(createSnippetAction(document, 'Create ERC-1155 Multi-Token', 'erc1155-snippet', ERC1155_SNIPPET));
    actions.push(createSnippetAction(document, 'Create Ownable Contract', 'ownable-snippet', OWNABLE_SNIPPET));
  }

  // Compiler diagnostic quickfixes — registry first, then regex fallback
  for (const diag of diagnostics) {
    const fixes = diagnosticToCodeActions(diag, document, diagnostics);
    actions.push(...fixes);
  }

  return actions;
}

// ─── Registry-first dispatch with regex fallback ────────────────────────────

function diagnosticToCodeActions(
  diag: Diagnostic,
  document: TextDocument,
  allDiagnostics: Diagnostic[]
): CodeAction[] {
  // 1. Try registry by error code first
  const code = String(diag.code ?? '');
  const handler = compilerDiagnostics[code];
  if (handler) {
    return handler.resolve(diag, document, allDiagnostics);
  }

  // 2. Fall back to regex-based matching for unknown codes
  return regexFallback(diag, document, allDiagnostics);
}

function regexFallback(
  diag: Diagnostic,
  document: TextDocument,
  allDiagnostics: Diagnostic[]
): CodeAction[] {
  const msg = diag.message.toLowerCase();
  const line = diag.range.start.line;

  // Missing SPDX license identifier
  if (msg.includes('spdx license') || msg.includes('license identifier')) {
    return [createInsertAction(document, diag, 'Add SPDX-License-Identifier: MIT',
      { line: 0, character: 0 }, '// SPDX-License-Identifier: MIT\n')];
  }

  // Missing visibility
  if (msg.includes('visibility') || msg.includes('no visibility specified')) {
    const lineText = document.getText({
      start: { line, character: 0 },
      end: { line: line + 1, character: 0 },
    });
    const match = lineText.match(/function\s+(\w+)/);
    if (match) {
      const funcName = match[1];
      const editRange = findAfterText(document, line, `function ${funcName}`);
      return [createInsertAction(document, diag, 'Add public visibility',
        editRange, ' public')];
    }
  }

  // Function state mutability can be restricted
  if (msg.includes('mutability') || msg.includes('state mutability')) {
    if (msg.includes('view') || msg.includes('can be restricted')) {
      const editRange = findAfterKeyword(document, line, '{');
      return [createInsertAction(document, diag, 'Make function view',
        editRange, ' view')];
    }
  }

  // Missing override
  if (msg.includes('override') && !msg.includes('multiple')) {
    const editRange = findAfterFunctionSig(document, line);
    return [createInsertAction(document, diag, 'Add override', editRange, ' override')];
  }

  // Missing virtual
  if (msg.includes('virtual')) {
    const editRange = findAfterFunctionSig(document, line);
    return [createInsertAction(document, diag, 'Add virtual', editRange, ' virtual')];
  }

  // Missing abstract
  if (msg.includes('abstract') || msg.includes('unimplemented')) {
    const editRange = findBeforeContract(document, line);
    return [createInsertAction(document, diag, 'Make contract abstract', editRange, 'abstract ')];
  }

  // Missing data location
  if (msg.includes('data location') || msg.includes('storage location')) {
    const editRange = findBeforeVariableName(document, line);
    return [createInsertAction(document, diag, 'Add memory data location', editRange, ' memory')];
  }

  // Missing pragma solidity version
  if (msg.includes('pragma') && msg.includes('solidity') || msg.includes('source file requires different compiler version')) {
    const versionMatch = msg.match(/(\d+\.\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : '0.8.0';
    const firstLine = document.getText({ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } });
    const insertLine = firstLine.includes('SPDX') ? 1 : 0;
    return [createInsertAction(document, diag, `Add pragma solidity ^${version}`,
      { line: insertLine, character: 0 }, `pragma solidity ^${version};\n`)];
  }

  // Multiple base contracts need override
  if (msg.includes('multiple') && msg.includes('override')) {
    const editRange = findAfterFunctionSig(document, line);
    const baseMatch = msg.match(/override\s*(.*?)(?:\.|$)/i);
    const bases = baseMatch ? baseMatch[1] : '';
    return [createInsertAction(document, diag, 'Add override(...)',
      editRange, ` override(${bases})`)];
  }

  // Missing implementation — generate interface stubs
  if (msg.includes('missing implementation') || msg.includes('should be marked as abstract')) {
    const action = createImplementInterfaceAction(diag, document, allDiagnostics);
    return action ? [action] : [];
  }

  // Contract code too large — suggest via-ir
  if (msg.includes('contract code size') || msg.includes('code too large') || msg.includes('contract deployer code size')) {
    return [createViaIrAction(diag, document)];
  }

  return [];
}

// ─── Code Action Factories ──────────────────────────────────────────────────

function createSnippetAction(
  document: TextDocument,
  title: string,
  code: string,
  snippet: string
): CodeAction {
  const diag: Diagnostic = {
    range: Range.create(0, 0, 0, 0),
    message: title,
    severity: DiagnosticSeverity.Information,
    code,
    source: 'foundry-lsp',
  };

  return {
    title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit: {
      changes: {
        [document.uri]: [TextEdit.replace(fullRange(document), snippet)],
      },
    },
  };
}

function createInsertAction(
  document: TextDocument,
  diag: Diagnostic,
  title: string,
  position: { line: number; character: number },
  text: string
): CodeAction {
  return {
    title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit: {
      changes: {
        [document.uri]: [TextEdit.insert(position, text)],
      },
    },
  };
}

function createReplaceAction(
  document: TextDocument,
  diag: Diagnostic,
  title: string,
  range: Range,
  newText: string
): CodeAction {
  return {
    title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit: {
      changes: {
        [document.uri]: [TextEdit.replace(range, newText)],
      },
    },
  };
}

function createViaIrAction(diag: Diagnostic, document: TextDocument): CodeAction {
  const viaIrComment = '[profile.default]\nvia_ir = true\n';
  const title = 'Enable via-ir in foundry.toml to reduce contract size';

  return {
    title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit: {
      changes: {
        [document.uri]: [TextEdit.insert({ line: 0, character: 0 }, viaIrComment)],
      },
    },
  };
}

// ─── Text Position Utilities ────────────────────────────────────────────────

function findAfterText(document: TextDocument, line: number, searchText: string): { line: number; character: number } {
  const lineText = document.getText({
    start: { line, character: 0 },
    end: { line: line + 1, character: 0 },
  });
  const idx = lineText.indexOf(searchText);
  if (idx >= 0) {
    return { line, character: idx + searchText.length };
  }
  return { line, character: lineText.trimEnd().length };
}

function findAfterKeyword(document: TextDocument, line: number, keyword: string): { line: number; character: number } {
  return findAfterText(document, line, keyword);
}

function findAfterFunctionSig(document: TextDocument, line: number): { line: number; character: number } {
  const lineText = document.getText({
    start: { line, character: 0 },
    end: { line: line + 1, character: 0 },
  });
  const match = lineText.match(/function\s+\w+\s*\([^)]*\)/);
  if (match) {
    return { line, character: match.index! + match[0].length };
  }
  return { line, character: lineText.trimEnd().length };
}

function findBeforeContract(document: TextDocument, line: number): { line: number; character: number } {
  const lineText = document.getText({
    start: { line, character: 0 },
    end: { line: line + 1, character: 0 },
  });
  const match = lineText.match(/(contract|interface|library)\s/);
  if (match) {
    return { line, character: match.index! };
  }
  return { line, character: 0 };
}

function findBeforeVariableName(document: TextDocument, line: number): { line: number; character: number } {
  const lineText = document.getText({
    start: { line, character: 0 },
    end: { line: line + 1, character: 0 },
  });
  const match = lineText.match(/(\w+)\s*;/);
  if (match) {
    return { line, character: match.index! };
  }
  return { line, character: lineText.trimEnd().length };
}

function fullRange(document: TextDocument): Range {
  const lastLine = document.lineCount - 1;
  const text = document.getText();
  const lastLineStart = text.lastIndexOf('\n', text.length - 2) + 1;
  const lastLineLength = text.length - lastLineStart;
  return Range.create(0, 0, lastLine, lastLineLength);
}

// ─── Complex Quickfixes ─────────────────────────────────────────────────────

function createImplementInterfaceAction(
  diag: Diagnostic,
  document: TextDocument,
  allDiagnostics: Diagnostic[]
): CodeAction | null {
  // Find the contract line from the error
  const contractLine = diag.range.start.line;
  const contractLineText = document.getText({
    start: { line: contractLine, character: 0 },
    end: { line: contractLine + 1, character: 0 },
  });

  // Extract contract name
  const contractMatch = contractLineText.match(/contract\s+(\w+)/);
  if (!contractMatch) return null;

  // Find all "Missing implementation" note diagnostics
  const missingFuncs: string[] = [];
  for (const d of allDiagnostics) {
    if (d.message.toLowerCase().includes('missing implementation') && d !== diag) {
      const funcLine = d.range.start.line;
      const funcLineText = document.getText({
        start: { line: funcLine, character: 0 },
        end: { line: funcLine + 1, character: 0 },
      }).trim();

      const funcMatch = funcLineText.match(/(function\s+\w+\s*\([^)]*\)[^{;]*)/);
      if (funcMatch) {
        let sig = funcMatch[1].trim();
        sig = sig.replace(/;$/, '').trim();
        missingFuncs.push(sig);
      }
    }
  }

  if (missingFuncs.length === 0) return null;

  // Generate stub implementations
  let stubs = `\n    // --- Interface implementations ---\n`;
  for (const sig of missingFuncs) {
    const nameMatch = sig.match(/function\s+(\w+)/);
    const funcName = nameMatch ? nameMatch[1] : 'unknown';

    const returnsMatch = sig.match(/returns\s*\(([^)]+)\)/);
    let body = '';
    if (returnsMatch) {
      const returnTypes = returnsMatch[1].split(',').map(t => t.trim());
      if (returnTypes.length === 1) {
        const rt = returnTypes[0];
        if (rt === 'uint256' || rt === 'uint' || rt.includes('uint')) {
          body = '        return 0;';
        } else if (rt === 'bool') {
          body = '        return false;';
        } else if (rt === 'address') {
          body = '        return address(0);';
        } else if (rt === 'string memory') {
          body = '        return "";';
        } else if (rt === 'bytes memory') {
          body = '        return "";';
        } else {
          body = `        revert("${funcName}: not implemented");`;
        }
      } else {
        body = `        revert("${funcName}: not implemented");`;
      }
    } else {
      body = `        revert("${funcName}: not implemented");`;
    }

    stubs += `    ${sig} override {\n${body}\n    }\n\n`;
  }

  // Find the closing brace of the contract
  const lastLine = document.lineCount - 1;
  let closingBraceLine = lastLine;
  for (let i = lastLine; i >= contractLine; i--) {
    const lineText = document.getText({
      start: { line: i, character: 0 },
      end: { line: i + 1, character: 0 },
    });
    if (lineText.trim() === '}') {
      closingBraceLine = i;
      break;
    }
  }

  const insertPos = { line: closingBraceLine, character: 0 };

  return {
    title: `Implement interface functions (${missingFuncs.length} functions)`,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diag],
    edit: {
      changes: {
        [document.uri]: [TextEdit.insert(insertPos, stubs)],
      },
    },
  };
}
