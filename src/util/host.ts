// Helpers for cooperating with a host process (Automax V6) that runs
// autocode inside a terminal. When hosted, autocode emits structured signal
// lines the host can act on; standalone, those code paths fall back to
// ordinary OS behavior.

// True when autocode is launched by Automax (it sets AUTOMAX_PROXY_TOKEN).
export function isAutomaxHosted(): boolean {
  return Boolean(process.env.AUTOMAX_PROXY_TOKEN);
}

// Emit a host-protocol line to stdout. The host (V6, Phase 9) scans for the
// `@@autocode:` prefix and filters these lines out of the visible terminal.
export function emitHostSignal(type: string, payload: unknown): void {
  process.stdout.write(`@@autocode:${type} ${JSON.stringify(payload)}\n`);
}

// The platform command to open a URL in the user's default browser.
export function osOpenCommand(url: string): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'win32':
      // The empty "" is start's window-title argument; without it a quoted
      // URL would be treated as the title.
      return { cmd: 'cmd', args: ['/c', 'start', '""', url] };
    case 'darwin':
      return { cmd: 'open', args: [url] };
    default:
      return { cmd: 'xdg-open', args: [url] };
  }
}
