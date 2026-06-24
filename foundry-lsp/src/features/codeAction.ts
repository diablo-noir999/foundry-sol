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

  // Compiler diagnostic quickfixes
  for (const diag of diagnostics) {
    const fix = diagnosticToCodeAction(diag, document, diagnostics);
    if (fix) actions.push(fix);
  }

  return actions;
}

function diagnosticToCodeAction(diag: Diagnostic, document: TextDocument, allDiagnostics: Diagnostic[]): CodeAction | null {
  const msg = diag.message.toLowerCase();
  const line = diag.range.start.line;
  const lineText = document.getText({
    start: { line, character: 0 },
    end: { line: line + 1, character: 0 },
  });

  // Missing SPDX license identifier
  if (msg.includes('spdx license') || msg.includes('license identifier')) {
    return createInsertAction(document, diag, 'Add SPDX-License-Identifier: MIT',
      { line: 0, character: 0 }, '// SPDX-License-Identifier: MIT\n');
  }

  // Missing visibility
  if (msg.includes('visibility') || msg.includes('no visibility specified')) {
    const match = lineText.match(/function\s+(\w+)/);
    if (match) {
      const funcName = match[1];
      const editRange = findAfterText(document, line, `function ${funcName}`);
      return createInsertAction(document, diag, 'Add public visibility',
        editRange, ' public');
    }
  }

  // Function state mutability can be restricted
  if (msg.includes('mutability') || msg.includes('state mutability')) {
    if (msg.includes('view') || msg.includes('can be restricted')) {
      const editRange = findAfterKeyword(document, line, '{');
      return createInsertAction(document, diag, 'Make function view',
        editRange, ' view');
    }
  }

  // Missing override
  if (msg.includes('override') && !msg.includes('multiple')) {
    const editRange = findAfterFunctionSig(document, line);
    return createInsertAction(document, diag, 'Add override', editRange, ' override');
  }

  // Missing virtual
  if (msg.includes('virtual')) {
    const editRange = findAfterFunctionSig(document, line);
    return createInsertAction(document, diag, 'Add virtual', editRange, ' virtual');
  }

  // Missing abstract
  if (msg.includes('abstract') || msg.includes('unimplemented')) {
    const editRange = findBeforeContract(document, line);
    return createInsertAction(document, diag, 'Make contract abstract', editRange, 'abstract ');
  }

  // Missing data location
  if (msg.includes('data location') || msg.includes('storage location')) {
    const editRange = findBeforeVariableName(document, line);
    return createInsertAction(document, diag, 'Add memory data location', editRange, ' memory');
  }

  // 11.8: Missing pragma solidity version
  if (msg.includes('pragma') && msg.includes('solidity') || msg.includes('source file requires different compiler version')) {
    // Try to extract version from the error message
    const versionMatch = msg.match(/(\d+\.\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : '0.8.0';
    // Insert after SPDX license if present, otherwise at top
    const firstLine = document.getText({ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } });
    const insertLine = firstLine.includes('SPDX') ? 1 : 0;
    return createInsertAction(document, diag, `Add pragma solidity ^${version}`,
      { line: insertLine, character: 0 }, `pragma solidity ^${version};\n`);
  }

  // Multiple base contracts need override
  if (msg.includes('multiple') && msg.includes('override')) {
    const editRange = findAfterFunctionSig(document, line);
    // Extract base contract names from the error message
    const baseMatch = msg.match(/override\s*(.*?)(?:\.|$)/i);
    const bases = baseMatch ? baseMatch[1] : '';
    return createInsertAction(document, diag, 'Add override(...)',
      editRange, ` override(${bases})`);
  }

  // Missing implementation — generate interface stubs
  if (msg.includes('missing implementation') || msg.includes('should be marked as abstract')) {
    return createImplementInterfaceAction(diag, document, allDiagnostics);
  }

  return null;
}

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
  const contractName = contractMatch[1];

  // Find all "Missing implementation" note diagnostics
  const missingFuncs: string[] = [];
  for (const d of allDiagnostics) {
    if (d.message.toLowerCase().includes('missing implementation') && d !== diag) {
      // The note diagnostic points to the interface function signature
      const funcLine = d.range.start.line;
      const funcLineText = document.getText({
        start: { line: funcLine, character: 0 },
        end: { line: funcLine + 1, character: 0 },
      }).trim();

      // Extract the function signature
      const funcMatch = funcLineText.match(/(function\s+\w+\s*\([^)]*\)[^{;]*)/);
      if (funcMatch) {
        let sig = funcMatch[1].trim();
        // Clean up: remove trailing semicolons, add virtual + override
        sig = sig.replace(/;$/, '').trim();
        missingFuncs.push(sig);
      }
    }
  }

  if (missingFuncs.length === 0) return null;

  // Generate stub implementations
  let stubs = `\n    // --- Interface implementations ---\n`;
  for (const sig of missingFuncs) {
    // Parse function name and check if it's view/pure
    const nameMatch = sig.match(/function\s+(\w+)/);
    const funcName = nameMatch ? nameMatch[1] : 'unknown';
    const isView = sig.includes('view') || sig.includes('pure');

    // Generate appropriate return value
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
      // No return value — just a stub
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

  // Insert before the closing brace
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
