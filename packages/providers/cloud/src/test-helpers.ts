/**
 * Test-only helpers (not exported from the package index). Fictitious ids and
 * numbers only; no real tokens or secrets.
 */
import type { FetchLike } from './graph-client';

export const FAKE_TOKEN = 'EAAGtestTOKENnotREAL0000000000000000wxyz';
export const FAKE_PHONE_ID = '100000000000001';
export const FAKE_WABA_ID = '200000000000002';
export const FAKE_APP_SECRET = 'app-secret-for-tests-only';
export const TEST_NUMBER = '972559014410';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FakeReply =
  { status: number; json?: unknown; headers?: Record<string, string> } | { throws: Error };

/** Fake `fetch` that replays queued replies (or a router) and records every call. */
export function fakeFetch(replies: FakeReply[] | ((call: RecordedCall) => FakeReply)): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = Array.isArray(replies) ? [...replies] : null;
  const f: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    let body: unknown = init?.body ?? null;
    if (typeof body === 'string') body = JSON.parse(body);
    const call: RecordedCall = { url: input, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const reply = queue ? queue.shift() : (replies as (c: RecordedCall) => FakeReply)(call);
    if (!reply) throw new Error('fakeFetch: no reply queued');
    if ('throws' in reply) throw reply.throws;
    return new Response(reply.json === undefined ? '' : JSON.stringify(reply.json), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  };
  return { fetch: f, calls };
}

export function graphError(code: number, subcode?: number): unknown {
  return {
    error: {
      message: 'Graph says something went wrong',
      type: 'OAuthException',
      code,
      ...(subcode !== undefined ? { error_subcode: subcode } : {}),
      fbtrace_id: 'Atrace',
    },
  };
}

export function webhookFixture(opts: {
  nowSec: number;
  messages?: unknown[];
  statuses?: unknown[];
  phoneNumberId?: string;
}): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: FAKE_WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550000000',
                phone_number_id: opts.phoneNumberId ?? FAKE_PHONE_ID,
              },
              contacts: [{ profile: { name: 'Test User' }, wa_id: TEST_NUMBER }],
              ...(opts.messages ? { messages: opts.messages } : {}),
              ...(opts.statuses ? { statuses: opts.statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}
