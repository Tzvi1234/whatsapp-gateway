import { describe, expect, it } from 'vitest';
import { GraphClient } from './graph-client';
import { countBodyParams, filterTemplates, listTemplates, utilityTemplates } from './templates';
import { FAKE_TOKEN, FAKE_WABA_ID, fakeFetch } from './test-helpers';

const tpl = (name: string, status: string, category: string, body: string) => ({
  id: `t-${name}`,
  name,
  language: 'he',
  status,
  category,
  components: [{ type: 'BODY', text: body }],
});

describe('templates', () => {
  it('R4.3 lists approved templates across pages', async () => {
    const f = fakeFetch([
      {
        status: 200,
        json: {
          data: [tpl('appt_reminder', 'APPROVED', 'UTILITY', 'שלום {{1}}, התור ב-{{2}}')],
          paging: { cursors: { after: 'c1' }, next: 'https://graph.example/next' },
        },
      },
      { status: 200, json: { data: [tpl('promo', 'APPROVED', 'MARKETING', 'מבצע')] } },
    ]);
    const r = await listTemplates(new GraphClient({ fetch: f.fetch }), {
      wabaId: FAKE_WABA_ID,
      accessToken: FAKE_TOKEN,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((t) => [t.name, t.bodyParamCount])).toEqual([
      ['appt_reminder', 2],
      ['promo', 0],
    ]);
    expect(f.calls[0]!.url).toContain('status=APPROVED');
    expect(f.calls[1]!.url).toContain('after=c1');
    expect(utilityTemplates(r.value).map((t) => t.name)).toEqual(['appt_reminder']);
    expect(filterTemplates(r.value, { name: 'PRO' }).map((t) => t.name)).toEqual(['promo']);
  });

  it('propagates Graph errors and rejects bad WABA ids', async () => {
    const f = fakeFetch([{ status: 401, json: { error: { code: 190 } } }]);
    const r = await listTemplates(new GraphClient({ fetch: f.fetch }), {
      wabaId: FAKE_WABA_ID,
      accessToken: FAKE_TOKEN,
    });
    expect(!r.ok && r.error.code).toBe('invalid_credentials');
    const bad = await listTemplates(new GraphClient({ fetch: f.fetch }), {
      wabaId: '../x',
      accessToken: FAKE_TOKEN,
    });
    expect(bad.ok).toBe(false);
  });

  it('counts distinct placeholders', () => {
    expect(countBodyParams('{{1}} {{2}} {{1}}')).toBe(2);
    expect(countBodyParams(null)).toBe(0);
  });
});
