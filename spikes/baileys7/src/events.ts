import fs from 'node:fs';
import path from 'node:path';

export type SpikeEvent = {
  ts: string;
  type: string;
  [k: string]: unknown;
};

export function createEventLog(spikeHome: string) {
  const file = path.join(spikeHome, 'events.jsonl');
  fs.mkdirSync(spikeHome, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(spikeHome, 0o700);
  } catch {
    /* */
  }
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '', { mode: 0o600 });
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* */
  }

  return {
    file,
    write(partial: Omit<SpikeEvent, 'ts'> & { ts?: string }) {
      const row: SpikeEvent = {
        ts: partial.ts ?? new Date().toISOString(),
        ...partial,
      };
      fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
    },
  };
}
