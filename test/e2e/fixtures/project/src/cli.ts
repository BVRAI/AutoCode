import { parseArgs } from './util.js';

const args = parseArgs(process.argv.slice(2));
const mode = args.mode ?? 'default';
run(mode);

function run(mode: string): void {
  console.log(`running in ${mode} mode`);
}
