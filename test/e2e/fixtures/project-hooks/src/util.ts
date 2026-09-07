export interface Args {
  mode?: string;
  [key: string]: string | boolean | undefined;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k!] = v ?? true;
    }
  }
  return out;
}
