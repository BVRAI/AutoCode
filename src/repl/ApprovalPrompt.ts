import { createInterface } from 'node:readline';
import pc from 'picocolors';

// Ask the user a yes/no question with an optional diff preview rendered
// before the prompt. Returns true on "y" / "yes" / "" (default Yes).
export async function requestApproval(
  label: string,
  detail?: string,
): Promise<boolean> {
  if (detail && detail.length > 0) {
    process.stderr.write(pc.dim('  --- preview ---') + '\n');
    process.stderr.write(detail + '\n');
    process.stderr.write(pc.dim('  ---------------') + '\n');
  }
  process.stderr.write(pc.yellow(`  ${label}`) + '\n');
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(pc.yellow('  apply? [Y/n] '), (answer) => {
      rl.close();
      const t = answer.trim().toLowerCase();
      resolve(t === '' || t === 'y' || t === 'yes');
    });
  });
}
