#!/usr/bin/env node
// Bundles the spike into dist/worker.mjs + dist/report.mjs. Workspace TS sources (@htz/core,
// @htz/provider-baileys, zod) are bundled; baileys, better-sqlite3 (native) and pino stay
// external and resolve from spikes/baileys7/node_modules at runtime.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  absWorkingDir: root,
  entryPoints: { worker: 'src/worker.ts', report: 'src/report.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  external: ['baileys', 'better-sqlite3', 'pino', 'pino/*'],
  // CJS deps bundled into ESM may call require(); give them one.
  banner: {
    js: "import { createRequire as __htzCreateRequire } from 'node:module'; const require = __htzCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
