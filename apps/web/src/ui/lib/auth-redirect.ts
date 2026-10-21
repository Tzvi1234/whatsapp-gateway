/**
 * Where to send the user when a server action fails for an auth reason (actions README):
 * `unauthenticated` → /login, `mfa_required` → /mfa, `not_owner`/`not_member` → /forbidden.
 * Returns null for every other failure (show `message_he`).
 */
export function authRedirectFor(code: string, currentPath = '/'): string | null {
  const next = encodeURIComponent(safeNext(currentPath));
  switch (code) {
    case 'unauthenticated':
      return `/login?next=${next}`;
    case 'mfa_required':
      return `/mfa?next=${next}`;
    case 'not_owner':
    case 'not_member':
      return '/forbidden';
    default:
      return null;
  }
}

/** Only same-origin relative paths (mirrors server/route-policy safeNext; no open redirect). */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw;
}
