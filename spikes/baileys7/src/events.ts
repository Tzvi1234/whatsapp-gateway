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
    write(partial: { type: string; ts?: string; [k: string]: unknown }) {
      const { ts, type, ...rest } = partial;
      const row: SpikeEvent = { ts: ts ?? new Date().toISOString(), type, ...rest };
      fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
    },
  };
}
