import { describe, expect, it } from 'vitest';
import { applyName, renderReply, replyConfigSchema, type ReplyCapabilities } from './reply';

const UNSUPPORTED: ReplyCapabilities = { nativeButtons: 'unsupported', lists: 'unsupported' };
const SUPPORTED: ReplyCapabilities = { nativeButtons: 'supported', lists: 'supported' };
const cfg = (over: Record<string, unknown> = {}) =>
  replyConfigSchema.parse({ text: 'היי {name}, תודה!', ...over });

describe('renderReply', () => {
  it('R1.6 {name} replaced with the push name', () => {
    const r = renderReply(cfg(), { pushName: 'דנה', capabilities: UNSUPPORTED });
    expect(r.text).toBe('היי דנה, תודה!');
    expect(r.deliveryMode).toBe('text');
  });

  it('R1.6 empty name leaves no dangling spaces or punctuation', () => {
    expect(applyName('היי {name}, תודה!', '')).toBe('היי, תודה!');
    expect(applyName('Hi {name}!', null)).toBe('Hi!');
    expect(applyName('{name}, welcome', '   ')).toBe('welcome');
    expect(applyName('a {name} b\n{name}', undefined)).toBe('a b\n');
  });

  it('R1.6 push name is sanitised and cannot inject a template', () => {
    expect(applyName('Hi {name}', '{name}\u202E\u0000Eve')).toBe('Hi nameEve');
  });

  it('R1.8 options 1..10 become a numbered list with safe links', () => {
    const r = renderReply(
      cfg({
        options: [{ label: 'מחירון', url: 'https://shop.example/prices' }, { label: 'שעות' }],
      }),
      { pushName: 'דנה', capabilities: UNSUPPORTED },
    );
    expect(r.text).toBe('היי דנה, תודה!\n\n1. מחירון (https://shop.example/prices)\n2. שעות');
  });

  it('R1.8 an 11th option is rejected by validation', () => {
    const options = Array.from({ length: 11 }, (_v, i) => ({ label: `o${i}` }));
    expect(replyConfigSchema.safeParse({ text: 'x', options }).success).toBe(false);
    expect(replyConfigSchema.safeParse({ text: 'x', options: options.slice(0, 10) }).success).toBe(
      true,
    );
  });

  it('R1.8 only http(s) links are allowed', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://x.example',
      'https://u:p@x.example',
    ]) {
      expect(
        replyConfigSchema.safeParse({ text: 'x', options: [{ label: 'a', url }] }).success,
      ).toBe(false);
    }
    expect(
      replyConfigSchema.safeParse({ text: 'x', options: [{ label: 'javascript:alert(1)' }] })
        .success,
    ).toBe(false);
    expect(replyConfigSchema.safeParse({ text: 'go javascript:alert(1)' }).success).toBe(false);
  });

  it('R1.7 media attached: media sent, native buttons not attempted', () => {
    const r = renderReply(
      cfg({
        media: { storagePath: 'media/a.jpg', mime: 'image/jpeg' },
        nativeButtons: true,
        options: [{ label: 'כן' }],
      }),
      { pushName: 'דנה', capabilities: SUPPORTED },
    );
    expect(r.interactive).toBeNull();
    expect(r.media).toEqual({
      storagePath: 'media/a.jpg',
      mime: 'image/jpeg',
      caption: 'היי דנה, תודה!\n\n1. כן',
    });
    expect(r.deliveryMode).toBe('fallback');
  });

  it('R1.9 native requested but capability unsupported/unverified → numbered text, fallback', () => {
    for (const nativeButtons of ['unsupported', 'unverified'] as const) {
      const r = renderReply(
        cfg({ nativeButtons: true, options: [{ label: 'כן' }, { label: 'לא' }] }),
        {
          pushName: 'x',
          capabilities: { nativeButtons, lists: nativeButtons },
        },
      );
      expect(r.deliveryMode).toBe('fallback');
      expect(r.interactive).toBeNull();
      expect(r.text).toContain('1. כן\n2. לא');
    }
  });

  it('R1.9 native requested and supported → native interactive (buttons ≤3, list >3)', () => {
    const r = renderReply(
      cfg({ nativeButtons: true, options: [{ label: 'כן' }, { label: 'לא' }] }),
      {
        pushName: 'x',
        capabilities: SUPPORTED,
      },
    );
    expect(r.deliveryMode).toBe('native');
    expect(r.interactive).toEqual({
      body: 'היי x, תודה!',
      options: ['כן', 'לא'],
      style: 'buttons',
    });
    const four = Array.from({ length: 4 }, (_v, i) => ({ label: `o${i}` }));
    const l = renderReply(cfg({ nativeButtons: true, options: four }), {
      pushName: 'x',
      capabilities: SUPPORTED,
    });
    expect(l.interactive?.style).toBe('list');
  });
});
