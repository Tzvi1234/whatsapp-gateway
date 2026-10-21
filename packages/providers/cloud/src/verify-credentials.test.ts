import { describe, expect, it } from 'vitest';
import { GraphClient } from './graph-client';
import { last4, verifyCloudCredentials, VERIFY_REASON_HE } from './verify-credentials';
import { FAKE_PHONE_ID, FAKE_TOKEN, FAKE_WABA_ID, fakeFetch, graphError } from './test-helpers';

const input = { phoneNumberId: FAKE_PHONE_ID, wabaId: FAKE_WABA_ID, accessToken: FAKE_TOKEN };
const phoneOk = {
  status: 200,
  json: {
    id: FAKE_PHONE_ID,
    display_phone_number: '+972 55-901-4410',
    verified_name: 'Test Business',
    quality_rating: 'GREEN',
  },
};
const wabaOk = { status: 200, json: { data: [{ id: '100000000000009' }, { id: FAKE_PHONE_ID }] } };

async function run(replies: Parameters<typeof fakeFetch>[0], i = input) {
  const f = fakeFetch(replies);
  const r = await verifyCloudCredentials(i, { graph: new GraphClient({ fetch: f.fetch }) });
  return { r, calls: f.calls };
}

describe('verifyCloudCredentials', () => {
  it('C4 succeeds with E.164 display number and only last4 of the token', async () => {
    const { r, calls } = await run([phoneOk, wabaOk]);
    expect(r).toEqual({
      ok: true,
      value: {
        phoneNumberId: FAKE_PHONE_ID,
        wabaId: FAKE_WABA_ID,
        displayPhoneNumber: '+972559014410',
        verifiedName: 'Test Business',
        qualityRating: 'GREEN',
        tokenLast4: 'wxyz',
      },
    });
    expect(calls[0]!.url).toContain(
      `/${FAKE_PHONE_ID}?fields=display_phone_number%2Cverified_name%2Cquality_rating`,
    );
    expect(calls[1]!.url).toContain(`/${FAKE_WABA_ID}/phone_numbers`);
    expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
  });

  it('C4 keeps a non-Israeli display number raw', async () => {
    const { r } = await run([
      { status: 200, json: { ...phoneOk.json, display_phone_number: '+1 555-000-0000' } },
      wabaOk,
    ]);
    expect(r.ok && r.value.displayPhoneNumber).toBe('+1 555-000-0000');
  });

  it('C4 wrong token → invalid_token', async () => {
    const { r, calls } = await run([{ status: 401, json: graphError(190) }]);
    expect(!r.ok && r.error).toMatchObject({
      reason: 'invalid_token',
      code: 'invalid_credentials',
    });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
  });

  it('C4 token without WhatsApp permissions → permission_denied', async () => {
    const { r } = await run([{ status: 403, json: graphError(200) }]);
    expect(!r.ok && r.error.reason).toBe('permission_denied');
  });

  it('C4 wrong phone number id → phone_number_not_found', async () => {
    const { r } = await run([{ status: 400, json: graphError(100, 33) }]);
    expect(!r.ok && r.error).toMatchObject({ reason: 'phone_number_not_found', code: 'not_found' });
  });

  it('C4 wrong WABA id → waba_not_found', async () => {
    const { r } = await run([phoneOk, { status: 400, json: graphError(100, 33) }]);
    expect(!r.ok && r.error).toMatchObject({ reason: 'waba_not_found', code: 'not_found' });
  });

  it('C4 phone not in the WABA → phone_not_in_waba', async () => {
    const { r } = await run([
      phoneOk,
      { status: 200, json: { data: [{ id: '100000000000009' }] } },
    ]);
    expect(!r.ok && r.error.reason).toBe('phone_not_in_waba');
  });

  it('C4 malformed input is rejected without calling Graph', async () => {
    const { r, calls } = await run([], { ...input, phoneNumberId: 'abc' });
    expect(!r.ok && r.error.reason).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('C4 Graph outage → graph_unavailable (transient)', async () => {
    const { r } = await run([{ status: 503, json: {} }]);
    expect(!r.ok && r.error).toMatchObject({ reason: 'graph_unavailable', transient: true });
  });

  it('C4 every reason has Hebrew copy', () => {
    for (const v of Object.values(VERIFY_REASON_HE)) expect(v).toMatch(/[֐-׿]/);
  });

  it('C5 last4 masks secrets', () => {
    expect(last4(FAKE_TOKEN)).toBe('wxyz');
    expect(last4('short')).toBe('****');
  });
});
