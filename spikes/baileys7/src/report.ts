/**
 * `pnpm -C spikes/baileys7 report [events.jsonl]` → RL8 baseline as markdown for ADR-5.
 * Default input: ${SPIKE_HOME:-~/baileys-spike}/events.jsonl. Add `--json` for raw numbers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeBaseline, parseEvents, renderMarkdown } from './baseline';

const args = process.argv.slice(2);
const json = args.includes('--json');
const fileArg = args.find((a) => !a.startsWith('--'));
const home = process.env.SPIKE_HOME?.trim() || path.join(os.homedir(), 'baileys-spike');
const file = fileArg ?? path.join(home, 'events.jsonl');

if (!fs.existsSync(file)) {
  process.stderr.write(`events file not found: ${file}\n`);
  process.exit(1);
}
const baseline = computeBaseline(parseEvents(fs.readFileSync(file, 'utf8')));
process.stdout.write(json ? `${JSON.stringify(baseline, null, 2)}\n` : renderMarkdown(baseline));
