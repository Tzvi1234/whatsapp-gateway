#!/usr/bin/env node
// Bundles the worker into dist/main.mjs. Workspace TS sources (@htz/*), zod and supabase-js are
// bundled; baileys and pino stay external and resolve from apps/worker/node_modules at runtime
// (see README "Deploy"). better-sqlite3 is replaced by a stub (see plugin below).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const pinned = pkg.dependencies?.baileys ?? 'unknown';
let baileysVersion = pinned;
try {
  const require = createRequire(path.join(root, 'package.json'));
  let dir = path.dirname(require.resolve('baileys'));
  for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
    try {
      const p = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (p.name === 'baileys') {
        baileysVersion = p.version;
        break;
      }
    } catch {
      /* keep walking */
    }
  }
} catch {
  /* keep the pinned value */
}

await build({
  absWorkingDir: root,
  entryPoints: { main: 'src/main.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  external: ['baileys', 'pino', 'pino/*'],
  plugins: [
    {
      // better-sqlite3 is only used by the spike's SQLite store, which @htz/provider-baileys
      // re-exports from its index. The worker uses the Supabase store, so it gets a stub that
      // throws if ever called: no native module on the server.
      name: 'stub-better-sqlite3',
      setup(b) {
        b.onResolve({ filter: /^better-sqlite3$/ }, () => ({
          path: 'better-sqlite3',
          namespace: 'stub',
        }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents:
            "export default function Database() { throw new Error('better-sqlite3 is not bundled in gateway-worker'); }",
          loader: 'js',
        }));
      },
    },
  ],
  define: {
    __WORKER_VERSION__: JSON.stringify(pkg.version),
    __BAILEYS_VERSION__: JSON.stringify(baileysVersion),
  },
  // CJS deps bundled into ESM may call require(); give them one.
  banner: {
    js: "import { createRequire as __htzCreateRequire } from 'node:module'; const require = __htzCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
