#!/usr/bin/env node
export {};
// Branch before importing normal startup (dotenv, catalog, credentials and sessions).
if (process.argv.includes('--inspect')) {
  process.env.AUTOCODE_INSPECTION = '1';
  const { runInspectionWorker } = await import('./inspection/worker.js');
  await runInspectionWorker();
} else {
  await import('./main.js');
}
