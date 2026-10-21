import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpsRequestFn } from '@htz/policy';

vi.mock('server-only', () => ({}));

const fake = await import('./testing/fake-db');
const { setEnvForTests } = await import('./env');
const { materializeCloudMedia, cloudMediaObjectPath } = await import('./cloud-media');
const { deliverRelayBatch } = await import('./internal');

const ORG = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const MSG = '66666666-6666-4666-8666-666666666666';
const BATCH = '44444444-4444-4444-8444-444444444444';
const TARGET = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'EAA-cloud-token-for-tests-0000';
const WAMID = 'wamid.HBgMOTcyNTAwMDAwMDAzFQIAEhgg';

const msg = (over: Record<string, unknown> = {}) => ({
  id: MSG,
  org_id: ORG,
  account_id: ACCOUNT,
  provider_message_id: WAMID,
  media_path: 'graph-media:1234567890',
  media_mime: 'audio/ogg',
  ...over,
});

function db(opts: { creds?: boolean } = {}) {
  return fake.createFakeDb({
    rpc: {
      provider_credentials_read: () => ({
        data:
          opts.creds === false
            ? []
            : [
                {
                  phone_number_id: '1000001',
                  waba_id: '2',
                  access_token: TOKEN,
                  app_secret: 'a',
                  verify_token: 'v',
                },
              ],
      }),
    },
  });
}

function graphFetch(
  o: { url?: string; fileSize?: number; body?: Uint8Array; status?: number } = {},
) {
  const calls: { url: string; auth: string | null }[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ url, auth });
    if (url.startsWith('https://graph.facebook.com/')) {
      return Response.json({
        url: o.url ?? 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
        mime_type: 'audio/ogg; codecs=opus',
        file_size: o.fileSize ?? 3,
      });
    }
    return new Response(Buffer.from(o.body ?? new Uint8Array([1, 2, 3])), {
      status: o.status ?? 200,
    });
  });
  return { f: f as unknown as typeof fetch, calls };
}

beforeEach(() => setEnvForTests(fake.testEnv()));

describe('Cloud inbound media → private Storage (deferred to the deliver step)', () => {
  it('S9 Graph lookup → download with the token → Storage <org>/<account>/<id> → media_path updated', async () => {
    const d = db();
    const g = graphFetch();
    const r = await materializeCloudMedia(d.db, msg(), { fetchImpl: g.f });
    const path = cloudMediaObjectPath(ORG, ACCOUNT, WAMID);
    expect(r).toEqual({ ok: true, value: path });
    expect(path).toMatch(new RegExp(`^${ORG}/${ACCOUNT}/[0-9a-f]{40}$`));
    expect(g.calls.map((c) => c.url)).toEqual([
      'https://graph.facebook.com/v23.0/1234567890',
      'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
    ]);
    expect(g.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(d.uploads).toHaveLength(1);
    expect(d.uploads[0]).toMatchObject({ bucket: 'media', path });
    const upd = d.ops.find((op) => op.table === 'messages' && op.action === 'update')!;
    expect(upd.payload).toMatchObject({ media_path: path });
    // compare-and-set: only rows still pointing at the graph id
    expect(upd.filters).toContainEqual(['eq', 'media_path', 'graph-media:1234567890']);
  });

  it('S3 the token is never sent to a non-Meta download host', async () => {
    const d = db();
    const g = graphFetch({ url: 'https://evil.example.test/steal' });
    const r = await materializeCloudMedia(d.db, msg(), { fetchImpl: g.f });
    expect(r).toMatchObject({ ok: false, error: { code: 'provider_error' } });
    expect(g.calls).toHaveLength(1);
    expect(d.uploads).toHaveLength(0);
  });

  it('S9 size cap: declared file_size or streamed bytes over the cap → media_too_large, nothing stored', async () => {
    const big = db();
    const r1 = await materializeCloudMedia(big.db, msg(), {
      fetchImpl: graphFetch({ fileSize: 100 }).f,
      maxBytes: 10,
    });
    expect(r1).toMatchObject({ ok: false, error: { code: 'media_too_large' } });
    const lying = db();
    const r2 = await materializeCloudMedia(lying.db, msg(), {
      fetchImpl: graphFetch({ fileSize: 1, body: new Uint8Array(64) }).f,
      maxBytes: 10,
    });
    expect(r2).toMatchObject({ ok: false, error: { code: 'media_too_large' } });
    expect(big.uploads.length + lying.uploads.length).toBe(0);
  });

  it('S9 no Cloud token → provider_unconfigured, no network', async () => {
    const g = graphFetch();
    const r = await materializeCloudMedia(db({ creds: false }).db, msg(), { fetchImpl: g.f });
    expect(r).toMatchObject({ ok: false, error: { code: 'provider_unconfigured' } });
    expect(g.calls).toHaveLength(0);
  });

  it('S9 relay payload for a Cloud voice note carries a signed Storage URL (copied during delivery)', async () => {
    const f = fake.createFakeDb({
      rpc: {
        vault_read_secret: () => ({ data: 'relay-sender-key-for-tests-000000' }),
        provider_credentials_read: () => ({
          data: [
            {
              phone_number_id: '1',
              waba_id: '2',
              access_token: TOKEN,
              app_secret: 'a',
              verify_token: 'v',
            },
          ],
        }),
        relay_batch_delivery_result: () => ({ data: 'accepted' }),
      },
      table: (op) => {
        if (op.table === 'relay_batches') {
          return {
            data: {
              batch_id: BATCH,
              relay_target_id: TARGET,
              account_id: ACCOUNT,
              message_ids: [MSG],
              is_test: false,
              status: null,
              attempts: 0,
              created_at: '2026-10-21T12:00:00Z',
            },
          };
        }
        if (op.table === 'relay_targets') {
          return {
            data: {
              id: TARGET,
              url: 'https://hooks.grok.example.test/lia/webhook',
              secret_vault_id: '77777777-7777-4777-8777-777777777777',
              enabled: true,
              no_reply_threshold_min: 10,
            },
          };
        }
        if (op.table === 'messages' && op.action === 'select') {
          return {
            data: [
              {
                ...msg(),
                kind: 'voice',
                body: null,
                sender_jid: '972500000003@s.whatsapp.net',
                received_at: '2026-10-21T12:00:00Z',
                created_at: '2026-10-21T12:00:00Z',
                transcript: null,
                quoted_provider_id: null,
                is_forwarded: false,
              },
            ],
          };
        }
        return { data: null };
      },
    });
    const sent: string[] = [];
    const request = ((_o: unknown, cb: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & Record<string, unknown>;
      req.write = (b: Buffer) => sent.push(b.toString('utf8'));
      req.destroy = () => undefined;
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
        res.statusCode = 200;
        res.headers = {};
        res.resume = () => undefined;
        res.destroy = () => undefined;
        cb(res);
        res.emit('end');
      };
      return req;
    }) as unknown as HttpsRequestFn;
    await deliverRelayBatch(f.db, BATCH, {
      mediaFetch: graphFetch().f,
      fetchOptions: { resolver: async () => ['93.184.216.34'], request },
    });
    const payload = JSON.parse(sent.join(''));
    const path = cloudMediaObjectPath(ORG, ACCOUNT, WAMID);
    expect(payload.messages[0].media_url).toBe(
      `https://storage.example.test/${path}?ttl=900&token=signed`,
    );
    expect(sent.join('')).not.toContain(TOKEN);
  });
});
