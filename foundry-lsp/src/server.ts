import {
  InitializeParams,
  InitializeResult,
  CompletionItem,
  Definition,
  Hover,
  CodeAction,
  DocumentSymbol,
  Location,
  Diagnostic,
} from 'vscode-languageserver';
import { connection } from './connection';
import { documents } from './documents';
import { SERVER_CAPABILITIES } from './capabilities';
import { projectManager } from './project';
import { compilerManager } from './compiler';
import { provideHover } from './features/hover';
import { provideCompletion } from './features/completion';
import { provideDefinition } from './features/definition';
import { provideCodeActions } from './features/codeAction';
import { provideDocumentSymbols } from './features/documentSymbol';
import { provideReferences } from './features/references';
import { provideFormatting } from './features/formatting';
import { provideRename } from './features/rename';
import { provideTypeDefinition } from './features/typeDefinition';
import { provideSemanticTokens } from './features/semanticTokens';
import { provideSignatureHelp } from './features/signatureHelp';
import { provideWorkspaceSymbols } from './features/workspaceSymbol';
import { provideImplementation } from './features/implementation';
import { solhintLinter } from './linter/solhint';

// Diagnostics manager: merge compiler + solhint diagnostics per URI
const diagnosticStore = new Map<string, { compiler: Diagnostic[]; solhint: Diagnostic[] }>();

function pushDiagnostics(uri: string, source: 'compiler' | 'solhint', diags: Diagnostic[]) {
  let entry = diagnosticStore.get(uri);
  if (!entry) {
    entry = { compiler: [], solhint: [] };
    diagnosticStore.set(uri, entry);
  }
  entry[source] = diags;
  const merged = [...entry.compiler, ...entry.solhint];
  connection.sendDiagnostics({ uri, diagnostics: merged });
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  connection.console.log(
    `foundry-lsp starting — client: ${params.clientInfo?.name ?? 'unknown'}`
  );
  connection.console.log(
    `workspace folders: ${JSON.stringify(params.workspaceFolders)}`
  );

  // Check capabilities from extension
  const initOptions = params.initializationOptions as any;
  const capabilities = initOptions?.capabilities ?? {};
  if (capabilities.forge === false) {
    connection.console.warn('foundry-lsp: forge not found — compilation will not work');
    connection.sendNotification('window/showMessage', {
      type: 2, // Warning
      message: 'Foundry Sol: forge not found. Please install Foundry (https://getfoundry.sh) for compilation support.',
    });
  }
  if (capabilities.node === false) {
    connection.console.error('foundry-lsp: node not found — LSP cannot function');
    connection.sendNotification('window/showMessage', {
      type: 1, // Error
      message: 'Foundry Sol: Node.js not found. Please install Node.js to use the LSP.',
    });
  }

  projectManager.init(params.workspaceFolders ?? null);

  return {
    capabilities: SERVER_CAPABILITIES,
    serverInfo: {
      name: 'foundry-lsp',
      version: '0.1.0',
    },
  };
});

connection.onInitialized(() => {
  connection.console.log('foundry-lsp initialized');
});

connection.onShutdown(() => {
  compilerManager.dispose();
  projectManager.dispose();
  solhintLinter.dispose();
  connection.console.log('foundry-lsp shutting down');
});

connection.onExit(() => {
  process.exit(0);
});

// Compile on document open/change and push diagnostics
documents.onDidOpen((event) => {
  const uri = event.document.uri;
  const content = event.document.getText();
  connection.console.log(`Document opened: ${uri}`);

  compilerManager.compile(uri, content).then((result) => {
    if (result) {
      pushDiagnostics(uri, 'compiler', result.diagnostics);
      connection.console.log(
        `Compiled ${uri}: ${result.diagnostics.length} diagnostics, ast=${result.ast ? 'yes' : 'no'}`
      );
    } else {
      connection.console.log(`Compile returned null for ${uri}`);
    }
  });

  // Also run solhint linter
  const project = projectManager.getProject(uri);
  if (project) {
    const filePath = require('vscode-uri').URI.parse(uri).fsPath;
    solhintLinter.lint(uri, filePath, content, (lintDiags) => {
      pushDiagnostics(uri, 'solhint', lintDiags);
    });
  }
});

documents.onDidChangeContent((change) => {
  const uri = change.document.uri;
  const content = change.document.getText();

  compilerManager.compileWithDebounce(uri, content, (diagnostics) => {
    pushDiagnostics(uri, 'compiler', diagnostics);
  });

  // Also run solhint linter
  const project = projectManager.getProject(uri);
  if (project) {
    const filePath = require('vscode-uri').URI.parse(uri).fsPath;
    solhintLinter.lint(uri, filePath, content, (lintDiags) => {
      pushDiagnostics(uri, 'solhint', lintDiags);
    });
  }
});

// ─── Phase 4: Feature Providers ───

connection.onCompletion((params): CompletionItem[] => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return [];

    const project = projectManager.getProject(uri);
    const result = compilerManager.getCachedResult(uri);

    if (!result?.ast) return [];

    return provideCompletion(result.ast, document, params.position, result, project);
  } catch (error) {
    return [];
  }
});

connection.onHover((params): Hover | null => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return null;

    const result = compilerManager.getCachedResult(uri);

    if (!result?.ast) return null;

    return provideHover(result.ast, document, params.position, result);
  } catch (error) {
    return null;
  }
});

connection.onDefinition((params): Definition | null => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return null;

    const project = projectManager.getProject(uri);
    const result = compilerManager.getCachedResult(uri);

    if (!result?.ast) return null;

    return provideDefinition(result.ast, document, params.position, result, project);
  } catch (error) {
    return null;
  }
});

connection.onCodeAction((params): CodeAction[] => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return [];

    const result = compilerManager.getCachedResult(uri);

    if (!result?.ast) return [];

    return provideCodeActions(result.ast, document, params.range, params.context.diagnostics, result);
  } catch (error) {
    return [];
  }
});

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return [];

    const result = compilerManager.getCachedResult(uri);

    if (!result?.ast) return [];

    return provideDocumentSymbols(result.ast, document.getText());
  } catch (error) {
    return [];
  }
});

connection.onReferences((params): Location[] => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return [];

    const result = compilerManager.getCachedResult(uri);

    if (!result?.ast) return [];

    return provideReferences(
      result.ast,
      document,
      params.position,
      result,
      params.context.includeDeclaration
    );
  } catch (error) {
    return [];
  }
});

connection.onDocumentFormatting(async (params) => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return [];

    return await provideFormatting(document);
  } catch (error) {
    return [];
  }
});

connection.onRenameRequest((params) => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return null;

    const result = compilerManager.getCachedResult(uri);
    if (!result?.ast) return null;

    return provideRename(result.ast, document, params.position, params.newName, result);
  } catch (error) {
    return null;
  }
});

connection.onPrepareRename((params) => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return null;

    const result = compilerManager.getCachedResult(uri);
    if (!result?.ast) return null;

    const { findNodeAtPosition } = require('./ast/traversal');
    const node = findNodeAtPosition(result.ast, document.getText(), params.position);
    if (!node || !node.name) return null;

    return { defaultBehavior: true };
  } catch (error) {
    return null;
  }
});

connection.onTypeDefinition((params) => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return null;

    const result = compilerManager.getCachedResult(uri);
    if (!result?.ast) return null;

    return provideTypeDefinition(result.ast, document, params.position, result);
  } catch (error) {
    return null;
  }
});

connection.onImplementation((params) => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return null;

    const result = compilerManager.getCachedResult(uri);
    if (!result?.ast) return null;

    return provideImplementation(result.ast, document, params.position, result);
  } catch (error) {
    return null;
  }
});

connection.languages.semanticTokens.on((params) => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return { data: [] };

    const result = compilerManager.getCachedResult(uri);
    if (!result?.ast) return { data: [] };

    return provideSemanticTokens(result.ast, document.getText());
  } catch (error) {
    return { data: [] };
  }
});

connection.onSignatureHelp((params) => {
  try {
    const uri = params.textDocument.uri;
    const document = documents.get(uri);
    if (!document) return null;

    const result = compilerManager.getCachedResult(uri);
    if (!result?.ast) return null;

    return provideSignatureHelp(result.ast, document, params.position, result);
  } catch (error) {
    return null;
  }
});

connection.onWorkspaceSymbol((params) => {
  try {
    return provideWorkspaceSymbols(params.query);
  } catch (error) {
    return [];
  }
});

documents.onDidClose((event) => {
  const uri = event.document.uri;
  compilerManager.invalidate(uri);
  diagnosticStore.delete(uri);
  connection.console.log(`Document closed: ${uri}`);
});

documents.listen(connection);
connection.listen();
