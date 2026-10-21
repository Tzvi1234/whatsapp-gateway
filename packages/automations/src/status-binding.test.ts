import { describe, expect, it } from 'vitest';
import { bindsTo, resolveBoundStatus, statusBindingSchema } from './status-binding';

const armedAt = '2026-10-21T10:00:00.000Z';
const next = statusBindingSchema.parse({ mode: 'next', armedAt });
const at = (min: number) => new Date(Date.parse(armedAt) + min * 60_000).toISOString();

describe('status binding', () => {
  it('R1.1 specific status binds only to that id', () => {
    const b = statusBindingSchema.parse({ mode: 'specific', statusId: 'st-1' });
    expect(bindsTo(b, { id: 'st-1', postedAt: at(-100) })).toEqual({
      bound: true,
      statusId: 'st-1',
    });
    expect(bindsTo(b, { id: 'st-2', postedAt: at(1) }).bound).toBe(false);
    expect(resolveBoundStatus(b, [])).toBe('st-1');
  });

  it('R1.2 "next status I post" binds to the first status posted within 10 min', () => {
    expect(
      resolveBoundStatus(next, [
        { id: 'old', postedAt: at(-1) },
        { id: 'second', postedAt: at(7) },
        { id: 'first', postedAt: at(3) },
      ]),
    ).toBe('first');
  });

  it('R1.2 older statuses are not bound; outside the window is not bound', () => {
    expect(bindsTo(next, { id: 'old', postedAt: at(-0.01) })).toEqual({
      bound: false,
      reason: 'before_arming',
    });
    expect(bindsTo(next, { id: 'late', postedAt: at(10.01) })).toEqual({
      bound: false,
      reason: 'outside_window',
    });
    expect(bindsTo(next, { id: 'edge', postedAt: at(10) }).bound).toBe(true);
    expect(resolveBoundStatus(next, [{ id: 'old', postedAt: at(-5) }])).toBeNull();
  });

  it('defaults the notify window to 10 minutes', () => {
    expect(next.mode === 'next' && next.notifyWindowMs).toBe(600_000);
  });
});
