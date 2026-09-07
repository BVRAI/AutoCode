// A tiny scripted language server for the LSP client tests: speaks JSON-RPC
// over stdio with Content-Length framing and answers the handful of methods
// the `lsp` tool uses. Every answer is deterministic and derived from the
// document the client opened.

let buffer = Buffer.alloc(0);
const openDocs = new Map();

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true, documentSymbolProvider: true } });
      // A server → client request the client must answer for the handshake to proceed.
      send({ jsonrpc: '2.0', id: 9001, method: 'workspace/configuration', params: { items: [{ section: 'typescript' }] } });
      return;
    case 'initialized':
      return;
    case 'textDocument/didOpen': {
      const { uri, text } = params.textDocument;
      openDocs.set(uri, text);
      const line = text.split('\n').findIndex((l) => l.includes('TODO'));
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics:
            line >= 0
              ? [{ range: { start: { line, character: 0 }, end: { line, character: 4 } }, severity: 2, message: 'Unresolved TODO', source: 'fake' }]
              : [],
        },
      });
      return;
    }
    case 'textDocument/didChange':
      openDocs.set(params.textDocument.uri, params.contentChanges[0].text);
      return;
    case 'textDocument/definition': {
      const { uri } = params.textDocument;
      const text = openDocs.get(uri) ?? '';
      const lines = text.split('\n');
      const word = wordAt(lines[params.position.line] ?? '', params.position.character);
      const defLine = lines.findIndex((l) => new RegExp(`(function|class|const)\\s+${word}\\b`).test(l));
      if (defLine < 0) return reply(id, null);
      const character = lines[defLine].indexOf(word);
      reply(id, [{ targetUri: uri, targetRange: { start: { line: defLine, character: 0 }, end: { line: defLine, character: 0 } }, targetSelectionRange: { start: { line: defLine, character }, end: { line: defLine, character: character + word.length } } }]);
      return;
    }
    case 'textDocument/references': {
      const { uri } = params.textDocument;
      const text = openDocs.get(uri) ?? '';
      const lines = text.split('\n');
      const word = wordAt(lines[params.position.line] ?? '', params.position.character);
      const out = [];
      lines.forEach((l, i) => {
        let from = 0;
        for (;;) {
          const at = l.indexOf(word, from);
          if (at < 0) break;
          out.push({ uri, range: { start: { line: i, character: at }, end: { line: i, character: at + word.length } } });
          from = at + word.length;
        }
      });
      reply(id, out);
      return;
    }
    case 'textDocument/hover': {
      const { uri } = params.textDocument;
      const lines = (openDocs.get(uri) ?? '').split('\n');
      const word = wordAt(lines[params.position.line] ?? '', params.position.character);
      reply(id, word ? { contents: { kind: 'markdown', value: `\`\`\`ts\nfunction ${word}(): number\n\`\`\`\nFake hover for ${word}.` } } : null);
      return;
    }
    case 'textDocument/documentSymbol': {
      const { uri } = params.textDocument;
      const lines = (openDocs.get(uri) ?? '').split('\n');
      const symbols = [];
      lines.forEach((l, i) => {
        const m = /^(?:export\s+)?(function|class)\s+([A-Za-z_$][\w$]*)/.exec(l);
        if (m) symbols.push({ name: m[2], kind: m[1] === 'class' ? 5 : 12, range: { start: { line: i, character: 0 }, end: { line: i, character: l.length } }, selectionRange: { start: { line: i, character: l.indexOf(m[2]) }, end: { line: i, character: l.indexOf(m[2]) + m[2].length } }, children: [] });
      });
      reply(id, symbols);
      return;
    }
    case 'shutdown':
      reply(id, null);
      return;
    case 'exit':
      process.exit(0);
      return;
    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

function wordAt(line, character) {
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m.index <= character && character <= m.index + m[0].length) return m[0];
  }
  return '';
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const m = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
    const length = m ? Number.parseInt(m[1], 10) : 0;
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString('utf8');
    buffer = buffer.subarray(start + length);
    try {
      const msg = JSON.parse(body);
      if (msg.method) handle(msg);
      // Responses to our own server→client requests are ignored.
    } catch {
      /* skip */
    }
  }
});
