import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const fake = await import('./testing/fake-db');
const { mediaOriginalUrl } = await import('./media-access');

const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '44444444-4444-4444-8444-444444444444';
const MSG = '66666666-6666-4666-8666-666666666666';

function userDb(row: Record<string, unknown> | null) {
  return fake.createFakeDb({ table: () => ({ data: row }) });
}

const voice = (media_path: string | null) => ({
  id: MSG,
  org_id: ORG,
  kind: 'voice',
  media_path,
  media_mime: 'audio/ogg',
});

describe('S9 play original (signed media URL)', () => {
  it('S9 returns a signed URL that expires within 15 minutes', async () => {
    const sign = fake.createFakeDb();
    const r = await mediaOriginalUrl(userDb(voice(`${ORG}/acc/WAIN0001`)).db, sign.db, ORG, MSG);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.expiresInSeconds).toBeLessThanOrEqual(900);
    expect(r.value.url).toContain('ttl=900');
    expect(r.value.url).toContain('token=');
  });

  it('S9 after the retention purge → media_purged error', async () => {
    const r = await mediaOriginalUrl(userDb(voice(null)).db, fake.createFakeDb().db, ORG, MSG);
    expect(r).toEqual({ ok: false, error: { code: 'media_purged' } });
  });

  it('S9 object already removed from Storage → media_purged error', async () => {
    const sign = fake.createFakeDb();
    (sign.db as unknown as { storage: unknown }).storage = {
      from: () => ({
        createSignedUrl: async () => ({ data: null, error: { message: 'Object not found' } }),
      }),
    };
    const r = await mediaOriginalUrl(userDb(voice(`${ORG}/acc/WAIN0001`)).db, sign.db, ORG, MSG);
    expect(r).toEqual({ ok: false, error: { code: 'media_purged' } });
  });

  it('S9 requires a message visible to the caller (RLS) in the caller org', async () => {
    expect(await mediaOriginalUrl(userDb(null).db, fake.createFakeDb().db, ORG, MSG)).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(
      await mediaOriginalUrl(
        userDb({ ...voice(`${OTHER_ORG}/a/b`), org_id: OTHER_ORG }).db,
        fake.createFakeDb().db,
        ORG,
        MSG,
      ),
    ).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(
      await mediaOriginalUrl(userDb(voice('x')).db, fake.createFakeDb().db, ORG, 'not-a-uuid'),
    ).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('S9 Cloud media not copied into Storage yet / foreign prefix → media_unavailable', async () => {
    for (const p of ['graph-media:123', `${OTHER_ORG}/a/b`]) {
      const r = await mediaOriginalUrl(userDb(voice(p)).db, fake.createFakeDb().db, ORG, MSG);
      expect(r).toEqual({ ok: false, error: { code: 'media_unavailable' } });
    }
  });
});
