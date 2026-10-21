const HOLD_OPEN = '\uE000';
const HOLD_CLOSE = '\uE001';
const BOLD = '\uE002';
const HOLD_RE = /\uE000(\d+)\uE001/g;
const HAS_HOLD = /\uE000\d+\uE001/;

const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

function convertLine(line: string): string | null {
  if (TABLE_SEPARATOR.test(line) && line.includes('-') && line.includes('|')) return null;
  if (TABLE_ROW.test(line)) {
    return line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .join(' | ');
  }
  const h = HEADING.exec(line);
  if (h) return `${BOLD}${h[1]!.replace(/\*\*|__/g, '')}${BOLD}`;
  if (HR.test(line)) return '';
  return line.replace(/^(\s*)[*+]\s+/, '$1- ');
}

/**
 * Markdown → WhatsApp formatting for agent replies (ARCH §4.7, TEST-PLAN L3.11):
 * `**b**`/`__b__` → `*b*`, `*i*`/`_i_` → `_i_`, `~~s~~` → `~s~`, inline/fenced code → ```` ``` ````,
 * headings → bold line, `[text](url)` → `text (url)`, images → alt text, HTML stripped,
 * tables → plain ` | ` rows, rules dropped. URLs and code are never reformatted.
 * Guarantees no raw `**` in the output.
 */
export function markdownToWhatsApp(markdown: string): string {
  const stash: string[] = [];
  const hold = (s: string) => `${HOLD_OPEN}${stash.push(s) - 1}${HOLD_CLOSE}`;
  let t = markdown.replace(/\r\n?/g, '\n').replace(/[\uE000-\uE002]/g, '');

  // code first: its content is literal
  t = t.replace(/^(?:```|~~~)[^\n]*\n([\s\S]*?)\n?(?:```|~~~)[ \t]*$/gm, (_m, code: string) =>
    hold('```' + code + '```'),
  );
  t = t.replace(/`([^`\n]+)`/g, (_m, code: string) => hold('```' + code + '```'));

  // html
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/?[a-zA-Z][^>\n]*>/g, '');

  // images, links (URL protected), bare URLs
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt: string) => alt);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, text: string, url: string) =>
    text.trim() === url ? hold(url) : `${text} (${hold(url)})`,
  );
  t = t.replace(/\bhttps?:\/\/[^\s)\uE000\uE001]+/g, (url) => hold(url));

  // block-level
  t = t
    .split('\n')
    .map(convertLine)
    .filter((l): l is string => l !== null)
    .join('\n');

  // inline
  t = t.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, `${BOLD}$1${BOLD}`);
  t = t.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, `$1${BOLD}$2${BOLD}`);
  t = t.replace(/~~(?=\S)([^\n]*?\S)~~/g, '~$1~');
  t = t.replace(
    /(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])?\*(?![\w*])/g,
    (_m, pre: string, body?: string) => (body === undefined ? `${pre}*` : `${pre}_${body}_`),
  );
  t = t.replace(/\*\*+/g, '');
  t = t.replaceAll(BOLD, '*');

  t = t
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  for (let i = 0; i < 4 && HAS_HOLD.test(t); i++) {
    t = t.replace(HOLD_RE, (_m, idx: string) => stash[Number(idx)] ?? '');
  }
  return t;
}
