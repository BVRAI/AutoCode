import { createInterface } from 'node:readline';
import { buildInspectionPreview, type InspectionRequest } from './Inspection.js';

export async function runInspectionWorker(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (line.length > 2 * 1024 * 1024) throw new Error('Inspection context is too large.');
      const request = JSON.parse(line) as InspectionRequest;
      const result = buildInspectionPreview(request);
      process.stdout.write(JSON.stringify(result) + '\n');
      return;
    }
    throw new Error('No inspection context was supplied.');
  } catch (e) {
    // JSON parser errors may include source text. Never echo input or file bodies.
    const error = e instanceof SyntaxError ? 'Invalid inspection request.'
      : e instanceof Error ? e.message : 'Inspection could not be completed.';
    process.stdout.write(JSON.stringify({ version: 1, error }) + '\n');
  } finally {
    input.close();
    process.stdin.pause();
  }
}
