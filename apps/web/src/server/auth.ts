import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { userClient } from './supabase';
import { clientIpFrom } from './http';
import { query } from './db';
import { AUTH_MESSAGES_HE, fail, type ActionResult } from './actions/result';

/**
 * Dashboard auth guards (ARCH §7.5, TEST-PLAN C1, R5.2). Identity comes from
 * `auth.getUser()` (verified with Supabase Auth, not just the cookie) and the assurance
 * level from `auth.mfa.getAuthenticatorAssuranceLevel()`; AAL2 is mandatory for any data.
 */

export type OrgRole = 'owner' | 'admin' | 'viewer';

export interface Viewer {
  userId: string;
  email: string | null;
  orgId: string;
  role: OrgRole;
  /** `last_sign_in_at` of the session (used for recent-login checks). */
  lastSignInAt: string | null;
}

export type AuthFailure =
  'unauthenticated' | 'mfa_required' | 'not_member' | 'not_owner' | 'auth_unavailable';

export type ViewerState = { ok: true; viewer: Viewer } | { ok: false; reason: AuthFailure };

const ROLE_ORDER: Record<OrgRole, number> = { owner: 0, admin: 1, viewer: 2 };

export async function getViewer(): Promise<ViewerState> {
  try {
    const sb = await userClient();
    const { data, error } = await sb.auth.getUser();
    if (error || !data.user) return { ok: false, reason: 'unauthenticated' };
    const user = data.user;

    const aal = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal.error) return { ok: false, reason: 'auth_unavailable' };
    if (aal.data?.currentLevel !== 'aal2') return { ok: false, reason: 'mfa_required' };

    // RLS: org_members is readable by members at AAL2 only (defence in depth).
    const m = await query<{ org_id: string; role: OrgRole }[] | null>(
      sb.from('org_members').select('org_id, role').eq('user_id', user.id),
      'org_members.viewer',
    );
    if (!m.ok) return { ok: false, reason: 'auth_unavailable' };
    const rows = (m.value ?? []).filter((r) => r.role in ROLE_ORDER);
    rows.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
    const best = rows[0];
    if (!best) return { ok: false, reason: 'not_member' };
    return {
      ok: true,
      viewer: {
        userId: user.id,
        email: user.email ?? null,
        orgId: best.org_id,
        role: best.role,
        lastSignInAt: user.last_sign_in_at ?? null,
      },
    };
  } catch {
    return { ok: false, reason: 'auth_unavailable' };
  }
}

function toFail(reason: AuthFailure) {
  return fail(reason, AUTH_MESSAGES_HE[reason]);
}

/** Any org member at AAL2 (read models). */
export async function requireMemberAal2(): Promise<ActionResult<Viewer>> {
  const v = await getViewer();
  return v.ok ? { ok: true, data: v.viewer } : toFail(v.reason);
}

/** Owner at AAL2 (connect screen, credentials, keys, allowlist; C1). */
export async function requireOwnerAal2(): Promise<ActionResult<Viewer>> {
  const v = await getViewer();
  if (!v.ok) return toFail(v.reason);
  if (v.viewer.role !== 'owner') return toFail('not_owner');
  return { ok: true, data: v.viewer };
}

function redirectFor(reason: AuthFailure): never {
  if (reason === 'unauthenticated') redirect('/login');
  if (reason === 'mfa_required') redirect('/mfa');
  redirect('/forbidden');
}

/** For server components/layouts, e.g. `app/(owner)/layout.tsx`. Redirects instead of returning. */
export async function assertOwnerPage(): Promise<Viewer> {
  const v = await getViewer();
  if (!v.ok) redirectFor(v.reason);
  if (v.viewer.role !== 'owner') redirectFor('not_owner');
  return v.viewer;
}

export async function assertMemberPage(): Promise<Viewer> {
  const v = await getViewer();
  if (!v.ok) redirectFor(v.reason);
  return v.viewer;
}

/** Client IP of the current request (audit, lockout). */
export async function requestIp(): Promise<string | null> {
  try {
    return clientIpFrom(await headers());
  } catch {
    return null;
  }
}
