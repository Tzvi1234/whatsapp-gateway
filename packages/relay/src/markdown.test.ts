import { describe, expect, it } from 'vitest';
import { markdownToWhatsApp as md } from './markdown';

describe('markdownToWhatsApp', () => {
  it('L3.11 bold, italic, strike', () => {
    expect(md('**bold** and __also__')).toBe('*bold* and *also*');
    expect(md('*it* and _it_')).toBe('_it_ and _it_');
    expect(md('~~gone~~')).toBe('~gone~');
    expect(md('**שלום** *עולם*')).toBe('*שלום* _עולם_');
  });

  it('L3.11 code inline and fenced → triple backticks, content untouched', () => {
    expect(md('run `npm **i**` now')).toBe('run ```npm **i**``` now');
    expect(md('```ts\nconst a = 1;\n```')).toBe('```const a = 1;```');
  });

  it('L3.11 headings become a bold line', () => {
    expect(md('# Title\n## Sub **x**\ntext')).toBe('*Title*\n*Sub x*\ntext');
  });

  it('L3.11 links become text (url), URLs never reformatted', () => {
    expect(md('see [the docs](https://ex.example/a_b_c)')).toBe(
      'see the docs (https://ex.example/a_b_c)',
    );
    expect(md('[https://ex.example](https://ex.example)')).toBe('https://ex.example');
    expect(md('bare https://ex.example/x_y_z here')).toBe('bare https://ex.example/x_y_z here');
  });

  it('L3.11 strips images, html, rules; tables → plain rows', () => {
    expect(md('![alt text](https://ex.example/i.png)')).toBe('alt text');
    expect(md('<b>hi</b><br>there<!-- c -->')).toBe('hi\nthere');
    expect(md('a\n\n---\n\nb')).toBe('a\n\nb');
    expect(md('| a | b |\n|---|:-:|\n| 1 | 2 |')).toBe('a | b\n1 | 2');
  });

  it('L3.11 bullets with * become dashes (not italics)', () => {
    expect(md('* one\n* two')).toBe('- one\n- two');
  });

  it('L3.11 no raw ** left, even for unbalanced input', () => {
    for (const input of ['**open', 'a ** b', '****', '**a** **b', '# **h**', '***x***']) {
      expect(md(input)).not.toContain('**');
    }
  });

  it('leaves plain text alone', () => {
    expect(md('שלום, מה שלומך? 2*3=6')).toBe('שלום, מה שלומך? 2*3=6');
  });
});
