'use client';

import { useCallback, useState, useTransition, type CSSProperties, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { ActionResult } from '@/server/actions/result';
import { reconnect, resendMessage } from '@/server/actions/connect';
import { resendRelayBatch } from '@/server/actions/relay';
import { logout } from '@/server/actions/auth';
import { he } from '../i18n/he';
import { authRedirectFor } from '../lib/auth-redirect';
import { Icon, type IconName } from './Icon';

/** Runs a server action; on auth failures navigates away, otherwise returns the result. */
export function useAction() {
  const router = useRouter();
  const path = usePathname();
  return useCallback(
    async <T,>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> => {
      let r: ActionResult<T>;
      try {
        r = await fn();
      } catch {
        r = { ok: false, code: 'internal', message_he: he.errors.generic };
      }
      if (!r.ok) {
        const to = authRedirectFor(r.code, path ?? '/');
        if (to) router.push(to);
      }
      return r;
    },
    [router, path],
  );
}

export function CopyButton({
  value,
  label = he.app.copy,
  className = 'btn',
  style,
}: {
  value: string;
  label?: string;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('ok');
    } catch {
      setState('fail');
    }
    setTimeout(() => setState('idle'), 2500);
  };
  return (
    <>
      <button type="button" className={className} style={style} onClick={copy}>
        <Icon name={state === 'ok' ? 'check' : 'copy'} />
        {state === 'ok' ? he.app.copied : label}
      </button>
      <span className="sr-only" aria-live="polite">
        {state === 'ok' ? he.app.copied : state === 'fail' ? he.app.copyFailed : ''}
      </span>
      {state === 'fail' ? <span className="hint err">{he.app.copyFailed}</span> : null}
    </>
  );
}

/** A button that runs one server action and reports the outcome in an aria-live region. */
function ActionButton<T>({
  run,
  label,
  icon,
  primary,
  small,
  okText,
}: {
  run: () => Promise<ActionResult<T>>;
  label: string;
  icon?: IconName;
  primary?: boolean;
  small?: boolean;
  okText: string;
}) {
  const act = useAction();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const onClick = () =>
    start(async () => {
      const r = await act(run);
      if (r.ok) {
        setMsg({ ok: true, text: okText });
        router.refresh();
      } else setMsg({ ok: false, text: r.message_he });
    });
  const cls = ['btn', primary ? 'primary' : '', small ? 'sm' : ''].filter(Boolean).join(' ');
  return (
    <span style={{ display: 'inline-grid', gap: 6, justifyItems: 'start' }}>
      <button
        type="button"
        className={cls}
        onClick={onClick}
        disabled={pending}
        aria-busy={pending}
      >
        {icon ? <Icon name={icon} className={pending ? 'spin' : undefined} /> : null}
        {pending ? he.actions.working : label}
      </button>
      <span
        aria-live="polite"
        className={msg ? (msg.ok ? 'msg ok' : 'msg bad') : 'sr-only'}
        style={{ marginTop: 0 }}
      >
        {msg?.text ?? ''}
      </span>
    </span>
  );
}

export function ReconnectButton({
  accountId,
  label = he.issue.actReconnect,
  primary = true,
}: {
  accountId: string;
  label?: string;
  primary?: boolean;
}) {
  return (
    <ActionButton
      run={() => reconnect(accountId)}
      label={label}
      icon="refresh"
      primary={primary}
      okText={he.actions.reconnectSent}
    />
  );
}

export function ResendButton({ messageId }: { messageId: string }) {
  return (
    <ActionButton
      run={() => resendMessage(messageId)}
      label={he.number.resend}
      icon="send"
      small
      okText={he.actions.resendSent}
    />
  );
}

export function ResendLiaButton({
  batchId,
  label = he.issue.actResendLia,
  primary = false,
  small = false,
}: {
  batchId: string;
  label?: string;
  primary?: boolean;
  small?: boolean;
}) {
  return (
    <ActionButton
      run={() => resendRelayBatch(batchId)}
      label={label}
      icon="send"
      primary={primary}
      small={small}
      okText={he.actions.resendLiaSent}
    />
  );
}

/** Collapsible "מה לבדוק" with stable codes (the only place codes appear, L5.8). */
export function WhatToCheck({ hint, codes }: { hint?: string | null; codes: string[] }) {
  if (!hint && codes.length === 0) return null;
  return (
    <details className="why">
      <summary>{he.app.whatToCheck}</summary>
      {hint ? <p>{hint}</p> : null}
      {codes.length ? (
        <p>
          {he.app.codeLabel}:{' '}
          {codes.map((c, i) => (
            <span key={c}>
              {i > 0 ? ' · ' : null}
              <code>{c}</code>
            </span>
          ))}
        </p>
      ) : null}
    </details>
  );
}

export function LogoutButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await logout();
          router.replace('/login');
          router.refresh();
        })
      }
    >
      {pending ? he.app.loggingOut : label}
    </button>
  );
}

export function LiveRegion({ children }: { children: ReactNode }) {
  return (
    <div aria-live="polite" role="status">
      {children}
    </div>
  );
}
