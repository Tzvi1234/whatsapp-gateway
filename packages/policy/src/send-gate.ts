import type { GatewayError, Result } from '@htz/core';
import { assertChatAllowed, type SendDecision, type SendGateContext } from './assert-chat-allowed';

/**
 * Every code path that can put a message on the wire (TEST-PLAN S13). Composition roots
 * (apps/web, apps/worker, packages/mcp) must route each of these through a `SendGate`.
 * Adding a new send path = add its id here; the S13 test then fails until it is wired.
 */
export const SEND_ENTRY_POINTS = [
  'mcp.send_message',
  'mcp.update_reply',
  'mcp.send_media',
  'mcp.send_template',
  'mcp.send_reminder',
  'mcp.send_group_message',
  'mcp.resend_message',
  'dashboard.send',
  'dashboard.resend',
  'relay.reply',
  'relay.system_reply',
  'reminders.dispatch',
  'automations.status_reply',
] as const;

export type SendEntryPoint = (typeof SEND_ENTRY_POINTS)[number];

export interface SendGateCall {
  entryPoint: SendEntryPoint;
  allowed: boolean;
  code: GatewayError['code'] | null;
}

export interface SendGate {
  /** Runs `assertChatAllowed` and tags the call with the entry point it came from. */
  check(entryPoint: SendEntryPoint, ctx: SendGateContext): Result<SendDecision, GatewayError>;
}

export interface SendGateOptions {
  /** Observability hook (audit/metrics). Must not throw; errors are swallowed. */
  onCheck?: (call: SendGateCall) => void;
}

/** Production gate: a thin wrapper so the entry point is always recorded alongside the decision. */
export function createSendGate(opts: SendGateOptions = {}): SendGate {
  return {
    check(entryPoint, ctx) {
      const r = assertChatAllowed(ctx);
      try {
        opts.onCheck?.({ entryPoint, allowed: r.ok, code: r.ok ? null : r.error.code });
      } catch {
        // observability must never change the decision
      }
      return r;
    },
  };
}

export interface RecordingSendGate extends SendGate {
  readonly calls: readonly SendGateCall[];
  /** Entry points from `expected` that never reached the gate. Empty = S13 passes. */
  ungated(expected?: readonly SendEntryPoint[]): SendEntryPoint[];
  reset(): void;
}

/**
 * Test helper for S13: inject this gate into a composition root, drive every send entry
 * point once, then assert `gate.ungated()` is empty.
 */
export function createRecordingSendGate(): RecordingSendGate {
  const calls: SendGateCall[] = [];
  const inner = createSendGate({ onCheck: (c) => calls.push(c) });
  return {
    check: inner.check,
    get calls() {
      return calls;
    },
    ungated(expected = SEND_ENTRY_POINTS) {
      const seen = new Set(calls.map((c) => c.entryPoint));
      return expected.filter((e) => !seen.has(e));
    },
    reset() {
      calls.length = 0;
    },
  };
}
