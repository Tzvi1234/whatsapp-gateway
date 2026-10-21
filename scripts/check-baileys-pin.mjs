#!/usr/bin/env node
// CI step 6 (CODE-STRUCTURE §4): every package that depends on `baileys` must pin the exact
// version recorded in docs/adr/0005-baileys-version.md (BAILEYS_VERSION line). No ^ or ~.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const adr = readFileSync(join(root, 'docs/adr/0005-baileys-version.md'), 'utf8');
const m = /^BAILEYS_VERSION:\s*`?([0-9][^`\s]*)`?\s*$/m.exec(adr);
if (!m) {
  console.error('BAILEYS_VERSION line not found in docs/adr/0005-baileys-version.md');
  process.exit(1);
}
const expected = m[1];

const dirs = ['apps', 'packages', 'packages/providers', 'spikes', 'scripts'];
const failures = [];
let checked = 0;
for (const d of dirs) {
  const abs = join(root, d);
  if (!existsSync(abs)) continue;
  for (const name of readdirSync(abs)) {
    const pkgPath = join(abs, name, 'package.json');
    if (!existsSync(pkgPath) || !statSync(pkgPath).isFile()) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const v = pkg[field]?.baileys;
      if (v === undefined) continue;
      checked++;
      if (v !== expected)
        failures.push(`${d}/${name}: ${field}.baileys = "${v}" (expected exact "${expected}")`);
    }
  }
}
if (failures.length) {
  console.error('Baileys pin check failed:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(`Baileys pin OK: ${checked} package(s) pinned to ${expected}`);
