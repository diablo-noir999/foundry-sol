const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVER_PATH = path.join(__dirname, '..', 'out', 'server.js');
const TEST_PROJECT = __dirname;

let msgId = 0;
let server;
let buffer = '';
let responses = [];
let diagnostics = [];

function sendMessage(msg) {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  server.stdin.write(header + body);
}

function sendRequest(method, params = {}) {
  msgId++;
  const msg = { jsonrpc: '2.0', id: msgId, method, params };
  sendMessage(msg);
  return msgId;
}

function sendNotification(method, params = {}) {
  const msg = { jsonrpc: '2.0', method, params };
  sendMessage(msg);
}

function parseMessages(data) {
  buffer += data.toString();
  // Find all complete messages
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;

    const header = buffer.substring(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/);
    if (!match) {
      // Bad header, skip to next potential header
      buffer = buffer.substring(headerEnd + 4);
      continue;
    }

    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;

    const body = buffer.substring(bodyStart, bodyStart + len);
    buffer = buffer.substring(bodyStart + len);

    try {
      const msg = JSON.parse(body);
      if (msg.id) responses.push(msg);
      if (msg.method === 'textDocument/publishDiagnostics') {
        diagnostics.push(msg.params);
      }
    } catch {}
  }
}

function waitForResponse(id, timeout = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const resp = responses.find(r => r.id === id);
      if (resp || Date.now() - start > timeout) {
        resolve(resp);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

function waitForDiagnostics(timeout = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (diagnostics.length > 0 || Date.now() - start > timeout) {
        resolve(diagnostics);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

async function main() {
  console.log('Starting foundry-lsp server...');
  server = spawn('node', [SERVER_PATH], {
    cwd: TEST_PROJECT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  server.stderr.on('data', (d) => {});
  server.stdout.on('data', parseMessages);

  await new Promise(r => setTimeout(r, 300));

  // 1. Initialize
  console.log('\n1. Initialize...');
  const initId = sendRequest('initialize', {
    processId: process.pid,
    rootUri: `file://${TEST_PROJECT}`,
    workspaceFolders: [{ uri: `file://${TEST_PROJECT}`, name: 'test-project' }],
    capabilities: {},
  });

  const initResp = await waitForResponse(initId);
  if (initResp?.result) {
    const caps = initResp.result.capabilities;
    console.log('  Server capabilities:');
    console.log(`    completionProvider: ${!!caps.completionProvider}`);
    console.log(`    hoverProvider: ${!!caps.hoverProvider}`);
    console.log(`    definitionProvider: ${!!caps.definitionProvider}`);
    console.log(`    referencesProvider: ${!!caps.referencesProvider}`);
    console.log(`    renameProvider: ${!!caps.renameProvider}`);
    console.log(`    codeActionProvider: ${!!caps.codeActionProvider}`);
    console.log(`    documentSymbolProvider: ${!!caps.documentSymbolProvider}`);
    console.log(`    documentFormattingProvider: ${!!caps.documentFormattingProvider}`);
    console.log(`    semanticTokensProvider: ${!!caps.semanticTokensProvider}`);
    console.log(`    typeDefinitionProvider: ${!!caps.typeDefinitionProvider}`);
    console.log(`    signatureHelpProvider: ${!!caps.signatureHelpProvider}`);
    console.log(`    workspaceSymbolProvider: ${!!caps.workspaceSymbolProvider}`);
  }

  sendNotification('initialized', {});
  await new Promise(r => setTimeout(r, 200));

  // 2. Open Vault.sol
  const vaultPath = path.join(TEST_PROJECT, 'src', 'Vault.sol');
  const vaultContent = fs.readFileSync(vaultPath, 'utf-8');
  const vaultUri = `file://${vaultPath}`;

  console.log('\n2. Opening Vault.sol...');
  diagnostics = [];
  sendNotification('textDocument/didOpen', {
    textDocument: { uri: vaultUri, languageId: 'solidity', version: 1, text: vaultContent },
  });

  // Wait for diagnostics
  const diags = await waitForDiagnostics(8000);
  if (diags.length > 0) {
    const last = diags[diags.length - 1];
    const errors = last.diagnostics.filter(d => d.severity === 1);
    const warnings = last.diagnostics.filter(d => d.severity === 2);
    console.log(`  Diagnostics: ${errors.length} errors, ${warnings.length} warnings`);
    for (const e of errors.slice(0, 3)) {
      console.log(`    ERROR [${e.range.start.line+1}:${e.range.start.character+1}]: ${e.message}`);
    }
  }

  // 3. Hover
  console.log('\n3. Testing hover...');
  const hoverId = sendRequest('textDocument/hover', {
    textDocument: { uri: vaultUri },
    position: { line: 39, character: 30 },
  });
  const hoverResp = await waitForResponse(hoverId);
  if (hoverResp?.result) {
    console.log('  Hover: found');
    console.log('  Content:', JSON.stringify(hoverResp.result.contents).substring(0, 120));
  } else {
    console.log('  Hover: no result');
  }

  // 4. Completion
  console.log('\n4. Testing completion...');
  const compId = sendRequest('textDocument/completion', {
    textDocument: { uri: vaultUri },
    position: { line: 42, character: 15 },
  });
  const compResp = await waitForResponse(compId);
  if (compResp?.result) {
    const items = Array.isArray(compResp.result) ? compResp.result : compResp.result.items || [];
    console.log(`  Completion: ${items.length} items`);
    if (items.length > 0) {
      console.log(`  First 5: ${items.slice(0, 5).map(i => i.label).join(', ')}`);
    }
  } else {
    console.log('  Completion: no result');
  }

  // 5. Definition
  console.log('\n5. Testing definition...');
  const defId = sendRequest('textDocument/definition', {
    textDocument: { uri: vaultUri },
    position: { line: 4, character: 15 },
  });
  const defResp = await waitForResponse(defId);
  if (defResp?.result) {
    const loc = Array.isArray(defResp.result) ? defResp.result[0] : defResp.result;
    if (loc?.uri) {
      console.log(`  Definition: ${path.basename(loc.uri)}:${loc.range.start.line+1}`);
    }
  } else {
    console.log('  Definition: no result');
  }

  // 6. Document symbols
  console.log('\n6. Testing document symbols...');
  const symId = sendRequest('textDocument/documentSymbol', {
    textDocument: { uri: vaultUri },
  });
  const symResp = await waitForResponse(symId);
  if (symResp?.result) {
    console.log(`  Symbols: ${symResp.result.length} top-level symbols`);
    for (const sym of symResp.result.slice(0, 8)) {
      console.log(`    ${sym.name} (kind ${sym.kind})`);
    }
  } else {
    console.log('  Document symbols: no result');
  }

  // 7. Workspace symbols
  console.log('\n7. Testing workspace symbols...');
  const wsId = sendRequest('workspace/symbol', { query: 'Vault' });
  const wsResp = await waitForResponse(wsId);
  if (wsResp?.result) {
    console.log(`  Workspace symbols: ${wsResp.result.length} results for "Vault"`);
    for (const sym of wsResp.result.slice(0, 5)) {
      console.log(`    ${sym.name} (kind ${sym.kind})`);
    }
  } else {
    console.log('  Workspace symbols: no result');
  }

  // 8. Signature help
  console.log('\n8. Testing signature help...');
  const sigId = sendRequest('textDocument/signatureHelp', {
    textDocument: { uri: vaultUri },
    position: { line: 71, character: 12 },
    context: { triggerKind: 1, triggerCharacter: '(' },
  });
  const sigResp = await waitForResponse(sigId);
  if (sigResp?.result) {
    console.log(`  Signature help: ${sigResp.result.signatures?.length || 0} signatures`);
  } else {
    console.log('  Signature help: no result');
  }

  console.log('\n✅ All tests complete!');
  server.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('Test failed:', err);
  if (server) server.kill();
  process.exit(1);
});
