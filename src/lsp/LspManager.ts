// One language server per language per project, started on first use by
// the `lsp` tool and stopped when the session ends.

import { LspClient, discoverServer, installHint, languageForPath, type LspLanguage } from './LspClient.js';

const clients = new Map<string, Promise<LspClient>>();

function key(projectRoot: string, language: LspLanguage): string {
  return `${projectRoot.replace(/\\/g, '/').toLowerCase()}::${language}`;
}

export function lspDisabled(): boolean {
  return process.env.AUTOCODE_NO_LSP === '1';
}

/** The client for a file's language, starting the server if needed. Throws a user-facing error when none is available. */
export async function clientForFile(projectRoot: string, absPath: string, overrides: Partial<Record<LspLanguage, string>> = {}): Promise<LspClient> {
  const language = languageForPath(absPath);
  if (!language) throw new Error(`no language server mapping for ${absPath} (supported: TypeScript/JavaScript, Python, C#, Go, Rust)`);
  const k = key(projectRoot, language);
  const existing = clients.get(k);
  if (existing) {
    const c = await existing;
    if (c.alive) return c;
    clients.delete(k);
  }
  const spec = discoverServer(language, projectRoot, overrides);
  if (!spec) throw new Error(`no ${language} language server found — ${installHint(language)}, or set AUTOCODE_LSP_${language.toUpperCase()}="<command>"`);
  const starting = LspClient.start(spec, projectRoot).catch((e: unknown) => {
    clients.delete(k);
    throw new Error(`could not start the ${language} language server (${spec.command}): ${e instanceof Error ? e.message : String(e)}`);
  });
  clients.set(k, starting);
  return starting;
}

export async function shutdownLsp(projectRoot?: string): Promise<void> {
  const entries = [...clients.entries()].filter(([k]) => !projectRoot || k.startsWith(`${projectRoot.replace(/\\/g, '/').toLowerCase()}::`));
  for (const [k, p] of entries) {
    clients.delete(k);
    try {
      const c = await p;
      await c.stop();
    } catch {
      /* never started */
    }
  }
}

export function lspStatus(): Array<{ key: string; alive: boolean }> {
  const out: Array<{ key: string; alive: boolean }> = [];
  for (const [k, p] of clients) {
    // A pending start counts as alive; a rejected one has already been removed.
    let alive = true;
    void p.then((c) => {
      alive = c.alive;
    });
    out.push({ key: k, alive });
  }
  return out;
}
