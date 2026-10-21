import { describe, expect, it } from 'vitest';
import { createShutdown } from './shutdown';
import { silentLogger } from './test/fakes';

describe('graceful shutdown', () => {
  it('runs steps in order once, survives a failing or hung step', async () => {
    const order: string[] = [];
    const shutdown = createShutdown(
      [
        { name: 'queue', run: async () => void order.push('queue') },
        {
          name: 'bad',
          run: async () => {
            order.push('bad');
            throw new Error('x');
          },
        },
        { name: 'hung', run: () => new Promise<void>(() => order.push('hung')), timeoutMs: 10 },
        { name: 'sessions', run: async () => void order.push('sessions') },
      ],
      silentLogger(),
    );
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGTERM')]);
    expect(order).toEqual(['queue', 'bad', 'hung', 'sessions']);
  });
});
