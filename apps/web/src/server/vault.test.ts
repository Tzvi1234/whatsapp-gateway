import { beforeEach, describe, expect, it, vi } from 'vitest';
import { err, gatewayError, ok } from '@htz/core';
import { VERIFY_REASON_HE, type VerifyFailureReason } from '@htz/provider-cloud';

vi.mock('server-only', () => ({}));

const { saveCloudCredentialsWith } = await import('./vault');
const { setEnvForTests } = await import('./env');
const { createFakeDb, testEnv } = await import('./testing/fake-db');

const ORG = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'EAAG-fictitious-access-token-1234WXYZ';
const APP_SECRET = 'abcdef0123456789abcdef0123456789';
const VERIFY = 'my-verify-token-5678';

const input = {
  accountId: ACCOUNT,
  phoneNumberId: '123456789012345',
  wabaId: '987654321098',
  accessToken: TOKEN,
  appSecret: APP_SECRET,
  verifyToken: VERIFY,
};
const actor = { userId: '33333333-3333-4333-8333-333333333333', orgId: ORG, ip: null };

function db() {
  return createFakeDb({
    rpc: { provider_credentials_upsert: () => ({ data: 'cred-id' }) },
    table: (op) =>
      op.table === 'accounts' && op.action === 'select'
        ? {
            data: {
              id: ACCOUNT,
              org_id: ORG,
              provider: 'meta_cloud',
              label: 'Cloud',
              alias: null,
              phone_e164: null,
              status: 'unconfigured',
              capabilities: {},
              use_case_policy: {},
              is_test: true,
              created_at: '2026-10-21T00:00:00Z',
            },
          }
        : { data: null },
  });
}

beforeEach(() => setEnvForTests(testEnv()));

describe('Cloud API credentials (C4, C5, S7)', () => {
  it.each<VerifyFailureReason>([
    'invalid_token',
    'waba_not_found',
    'phone_number_not_found',
    'phone_not_in_waba',
  ])('C4 %s → plain Hebrew error, nothing saved', async (reason) => {
    const f = db();
    const verify = vi.fn(async () =>
      err({ ...gatewayError('invalid_credentials', reason), reason }),
    );
    const r = await saveCloudCredentialsWith(f.db, input, actor, verify);
    expect(r).toEqual({ ok: false, code: reason, message_he: VERIFY_REASON_HE[reason] });
    expect(f.calledRpc('provider_credentials_upsert')).toHaveLength(0);
    expect(f.ops.filter((o) => o.action !== 'select')).toHaveLength(0);
  });

  it('C4 invalid input → Hebrew error, Graph never called, nothing saved', async () => {
    const f = db();
    const verify = vi.fn();
    const r = await saveCloudCredentialsWith(
      f.db,
      { ...input, phoneNumberId: 'abc' },
      actor,
      verify,
    );
    expect(r.ok).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    expect(f.calledRpc('provider_credentials_upsert')).toHaveLength(0);
  });

  it('C5 success → secrets go only to the Vault RPC; response carries last 4 chars only', async () => {
    const f = db();
    const verify = vi.fn(async () =>
      ok({
        phoneNumberId: input.phoneNumberId,
        wabaId: input.wabaId,
        displayPhoneNumber: '+972500000002',
        verifiedName: 'Test Biz',
        qualityRating: 'GREEN',
        tokenLast4: 'WXYZ',
      }),
    );
    const r = await saveCloudCredentialsWith(f.db, input, actor, verify);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.tokenLast4).toBe('WXYZ');
    expect(r.data.appSecretLast4).toBe('6789');
    expect(r.data.verifyTokenLast4).toBe('5678');
    expect(r.data.webhookUrl).toBe('https://gateway.example.test/api/meta/webhook');
    const out = JSON.stringify(r);
    for (const secret of [TOKEN, APP_SECRET, VERIFY]) expect(out).not.toContain(secret);
    const up = f.calledRpc('provider_credentials_upsert')[0]!.args;
    expect(up).toMatchObject({
      p_access_token: TOKEN,
      p_app_secret: APP_SECRET,
      p_verify_token: VERIFY,
    });
  });

  it('rejects an account of another org', async () => {
    const f = db();
    const r = await saveCloudCredentialsWith(f.db, input, { ...actor, orgId: ACCOUNT }, vi.fn());
    expect(r).toMatchObject({ ok: false, code: 'not_found' });
  });
});
