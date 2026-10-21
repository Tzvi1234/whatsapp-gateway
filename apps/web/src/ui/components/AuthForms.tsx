'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition, type FormEvent } from 'react';
import { login, mfaEnroll, mfaVerify } from '@/server/actions/auth';
import { he } from '../i18n/he';
import { safeNext } from '../lib/auth-redirect';
import { formatCountdown } from '../lib/time';
import { Icon, Num } from './Icon';

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Email + password (R5.1 lockout with retry time, optional Turnstile). Next step is MFA. */
export function LoginForm({ next, turnstile }: { next: string; turnstile: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const now = useNow(lockedUntil !== null);
  const locked = lockedUntil !== null && lockedUntil > now;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get('email') ?? '').trim();
    const password = String(fd.get('password') ?? '');
    const token = String(fd.get('cf-turnstile-response') ?? '');
    setError(null);
    start(async () => {
      const r = await login({ email, password, ...(token ? { turnstileToken: token } : {}) });
      if (r.ok) {
        router.push(`/mfa?next=${encodeURIComponent(safeNext(next))}`);
        return;
      }
      if (r.code === 'locked' && r.retryAfterSeconds) {
        setLockedUntil(Date.now() + r.retryAfterSeconds * 1000);
        return;
      }
      setError(r.message_he);
    });
  };

  return (
    <form className="card" onSubmit={onSubmit} noValidate>
      <div className="field">
        <label htmlFor="email">{he.auth.email}</label>
        <div className="inp">
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            dir="ltr"
            required
            inputMode="email"
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="password">{he.auth.password}</label>
        <div className="inp">
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            dir="ltr"
            required
          />
        </div>
      </div>
      {turnstile ? (
        <div className="turnstile" aria-label={he.auth.turnstile}>
          {he.auth.turnstile}
        </div>
      ) : null}
      <div aria-live="polite" role="status">
        {locked ? (
          <div className="res bad" style={{ marginTop: 16 }}>
            <span className="ic">
              <Icon name="alert" style={{ width: 16, height: 16 }} />
            </span>
            <strong>{he.auth.lockedTitle}</strong>
            <p>
              {he.auth.lockedBody}
              <Num>{formatCountdown((lockedUntil ?? now) - now)}</Num>
            </p>
          </div>
        ) : lockedUntil !== null ? (
          <p className="msg ok">{he.auth.lockedOver}</p>
        ) : null}
        {error ? (
          <p className="msg bad" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <button
        className="btn primary"
        type="submit"
        disabled={pending || locked}
        aria-busy={pending}
      >
        {pending ? he.auth.submitting : he.auth.submit}
      </button>
    </form>
  );
}

/** TOTP enrolment (QR from mfaEnroll + manual secret) or verification, then AAL2. */
export function MfaForm({ mode, next }: { mode: 'enroll' | 'verify'; next: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<{ factorId: string; qr: string; secret: string } | null>(
    null,
  );
  const [code, setCode] = useState('');

  const begin = () =>
    start(async () => {
      setError(null);
      const r = await mfaEnroll();
      if (!r.ok) {
        if (r.code === 'unauthenticated') router.replace('/login');
        setError(r.message_he);
        return;
      }
      setEnroll({ factorId: r.data.factorId, qr: r.data.qrCodeSvg, secret: r.data.secret });
    });

  const verify = (e: FormEvent) => {
    e.preventDefault();
    start(async () => {
      setError(null);
      const r = await mfaVerify({ code, ...(enroll ? { factorId: enroll.factorId } : {}) });
      if (!r.ok) {
        if (r.code === 'unauthenticated') router.replace('/login');
        setError(r.message_he);
        return;
      }
      setEnroll(null);
      router.replace(safeNext(next));
      router.refresh();
    });
  };

  const qrSrc = enroll
    ? enroll.qr.startsWith('data:')
      ? enroll.qr
      : `data:image/svg+xml;utf8,${encodeURIComponent(enroll.qr)}`
    : null;

  return (
    <div className="card">
      {mode === 'enroll' && !enroll ? (
        <>
          <p>{he.auth.mfaEnrollLead}</p>
          <button
            className="btn primary"
            type="button"
            onClick={begin}
            disabled={pending}
            aria-busy={pending}
          >
            {pending ? he.auth.mfaStarting : he.auth.mfaStart}
          </button>
        </>
      ) : (
        <form onSubmit={verify} noValidate>
          {enroll && qrSrc ? (
            <>
              <p>{he.auth.mfaEnrollLead}</p>
              <img className="qrimg" src={qrSrc} alt={he.auth.mfaQrAlt} width={200} height={200} />
              <p className="uses" style={{ textAlign: 'center' }}>
                {he.auth.mfaManual}
              </p>
              <p className="secret" style={{ textAlign: 'center', marginTop: 4 }}>
                <Num>{enroll.secret}</Num>
              </p>
            </>
          ) : (
            <p>{he.auth.mfaVerifyLead}</p>
          )}
          <div className="field">
            <label htmlFor="otp">{he.auth.code}</label>
            <div className="inp">
              <input
                id="otp"
                name="otp"
                className="num otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                dir="ltr"
                value={code}
                aria-describedby="otp-hint"
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                autoFocus
              />
            </div>
            <span className="hint" id="otp-hint">
              {he.auth.codeHint}
            </span>
          </div>
          <button
            className="btn primary"
            type="submit"
            disabled={pending || code.length !== 6}
            aria-busy={pending}
          >
            {pending ? he.auth.verifying : he.auth.verify}
          </button>
        </form>
      )}
      <div aria-live="polite" role="status">
        {error ? <p className="msg bad">{error}</p> : null}
      </div>
    </div>
  );
}
