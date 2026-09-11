#!/usr/bin/env node
export {};

// Dedicated desktop entry: an older runtime without this file cannot accidentally
// fall through into the normal CLI's network, session, or project initialization.
process.env.AUTOCODE_INSPECTION = '1';
const { runInspectionWorker } = await import('./worker.js');
await runInspectionWorker();
