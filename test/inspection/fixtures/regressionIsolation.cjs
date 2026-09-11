// Optional preload for focused legacy harness regressions. Their session setup
// predates per-test keyring mocks; this keeps the run inside disposable storage.
// Usage: node --require ./test/inspection/fixtures/regressionIsolation.cjs ./node_modules/vitest/vitest.mjs run ...
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autocode-regression-isolation-'));
const owner = process.pid;
for (const name of Object.keys(process.env)) {
  if (/TOKEN|SECRET|PASSWORD|API_KEY|^AUTOCODE_|^AUTOMAX_/i.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  HOME: root, USERPROFILE: root, LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
  AUTOCODE_CONFIG_DIR: path.join(root, 'config'), AUTOCODE_DATA_DIR: path.join(root, 'data'),
  NO_UPDATE_NOTIFIER: '1',
});
// Vitest workers and any fixture Node subprocesses need the same isolation.
const preload = __filename.replace(/\\/g, '/');
if (!(process.env.NODE_OPTIONS ?? '').includes(preload)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require "${preload}"`.trim();
}

const emptyKeyring = {
  getPassword: async () => null,
  setPassword: async () => undefined,
  deletePassword: async () => false,
  findPassword: async () => null,
  findCredentials: async () => [],
};
const keytarPath = require.resolve('keytar');
const keytarModule = new Module(keytarPath, module);
keytarModule.filename = keytarPath;
keytarModule.loaded = true;
keytarModule.exports = emptyKeyring;
require.cache[keytarPath] = keytarModule;

const denyNetwork = () => { throw new Error('Network disabled for isolated harness regressions'); };
globalThis.fetch = denyNetwork;
for (const name of ['node:http', 'node:https']) {
  const transport = require(name);
  transport.request = denyNetwork;
  transport.get = denyNetwork;
}
Module.syncBuiltinESMExports();

process.on('exit', () => {
  if (process.pid === owner) fs.rmSync(root, { recursive: true, force: true });
});
