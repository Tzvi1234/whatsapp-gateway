'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition, type FormEvent } from 'react';
import { SCOPES } from '@htz/core';
import { createApiKey, revokeApiKey, type ApiKeyView } from '@/server/actions/api-keys';
import { he } from '../i18n/he';
import { formatDateTime } from '../lib/time';
import { CopyButton, useAction, WhatToCheck } from './client';
import { Icon, Num } from './Icon';

const K = he.apiKeys;
const DEFAULT_SCOPES = ['messages:send', 'threads:read', 'sessions:read', 'accounts:read'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ApiKeys({
  keys,
  accounts,
  mcpUrl,
}: {
  keys: ApiKeyView[];
  accounts: { id: string; label: string; phoneDisplay: string | null }[];
  mcpUrl: string | null;
}) {
  const router = useRouter();
  const act = useAction();
  const [pending, start] = useTransition();
  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState<'form' | 'reauth'>('form');
  const [name, setName] = useState('');
  const [accIds, setAccIds] = useState<string[]>(accounts.length === 1 ? [accounts[0]!.id] : []);
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [convs, setConvs] = useState('');
  const [expires, setExpires] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string; code?: string } | null>(null);
  const [created, setCreated] = useState<{ name: string; token: string; mcpUrl: string } | null>(
    null,
  );
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const next = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = he.connect.required;
    if (accIds.length === 0) errs.accountIds = K.accountsRequired;
    if (scopes.length === 0) errs.scopes = K.scopesRequired;
    const ids = convs.split(/\s+/).filter(Boolean);
    if (scopes.includes('relay') && (ids.length === 0 || ids.some((x) => !UUID.test(x))))
      errs.conversationIds = K.conversationsHint;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setStep('reauth');
    setTimeout(() => pwRef.current?.focus(), 0);
  };

  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    const form = e.currentTarget;
    start(async () => {
      setMsg(null);
      const ids = convs.split(/\s+/).filter(Boolean);
      const r = await act(() =>
        createApiKey({
          name: name.trim(),
          scopes,
          accountIds: accIds,
          ...(scopes.includes('relay') ? { conversationIds: ids } : {}),
          ...(expires ? { expiresAt: new Date(`${expires}T23:59:59`).toISOString() } : {}),
          password,
        }),
      );
      form.reset();
      if (!r.ok) {
        setMsg({ ok: false, text: r.message_he, code: r.code });
        if (r.fields && Object.keys(r.fields).length) {
          setErrors(r.fields);
          setStep('form');
        }
        return;
      }
      setCreated({ name: r.data.name, token: r.data.token, mcpUrl: r.data.mcpUrl });
      setCreating(false);
      setStep('form');
      setName('');
      setConvs('');
      setExpires('');
      router.refresh();
    });
  };

  const revoke = (id: string) =>
    start(async () => {
      const r = await act(() => revokeApiKey(id));
      setConfirmRevoke(null);
      if (r.ok) {
        setMsg({ ok: true, text: K.revokedOk });
        router.refresh();
      } else setMsg({ ok: false, text: r.message_he, code: r.code });
    });

  const accLabel = (id: string) => accounts.find((a) => a.id === id)?.label ?? id.slice(0, 8);
  const now = Date.now();

  return (
    <>
      {mcpUrl ? (
        <div className="field" style={{ marginTop: 22 }}>
          <label>{K.mcpUrl}</label>
          <div className="copyrow">
            <span className="num" style={{ overflowWrap: 'anywhere' }}>
              {mcpUrl}
            </span>
            <CopyButton value={mcpUrl} style={{ height: 32 }} />
          </div>
        </div>
      ) : null}

      {created ? (
        <div className="res ok" role="alert" style={{ marginTop: 16 }}>
          <span className="ic">
            <Icon name="key" style={{ width: 16, height: 16 }} />
          </span>
          <strong>{K.tokenTitle}</strong>
          <p>{K.tokenBody}</p>
          <div className="copyrow" style={{ background: 'var(--surface)' }}>
            <span className="num secret">{created.token}</span>
            <CopyButton value={created.token} style={{ height: 32 }} />
          </div>
          <div className="acts">
            <button type="button" className="btn primary" onClick={() => setCreated(null)}>
              <Icon name="check" />
              {K.savedIt}
            </button>
          </div>
        </div>
      ) : null}

      <h2>
        {K.listTitle}
        <span className="spacer" />
        {!creating ? (
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {K.create}
          </button>
        ) : null}
      </h2>

      {creating ? (
        <section className="form" aria-labelledby="nk" style={{ marginTop: 0, marginBottom: 16 }}>
          <h3 id="nk" style={{ fontSize: 18, fontWeight: 600 }}>
            {K.createTitle}
          </h3>
          {step === 'form' ? (
            <form onSubmit={next} noValidate>
              <div className="field">
                <label htmlFor="k-name">{K.name}</label>
                <div className={errors.name ? 'inp err' : 'inp'}>
                  <input
                    id="k-name"
                    value={name}
                    placeholder={K.namePlaceholder}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={80}
                  />
                </div>
                {errors.name ? <span className="hint err">{errors.name}</span> : null}
              </div>
              <fieldset className="field" style={{ border: 0, padding: 0 }}>
                <legend style={{ fontWeight: 500, fontSize: 14 }}>{K.accounts}</legend>
                <div className="checks">
                  {accounts.map((a) => (
                    <label key={a.id}>
                      <input
                        type="checkbox"
                        checked={accIds.includes(a.id)}
                        onChange={() => setAccIds(toggle(accIds, a.id))}
                      />
                      <span>
                        {a.label}
                        {a.phoneDisplay ? (
                          <small>
                            <Num>{a.phoneDisplay}</Num>
                          </small>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
                {errors.accountIds ? <span className="hint err">{errors.accountIds}</span> : null}
              </fieldset>
              <fieldset className="field" style={{ border: 0, padding: 0 }}>
                <legend style={{ fontWeight: 500, fontSize: 14 }}>{K.scopes}</legend>
                <div
                  className="checks"
                  style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))' }}
                >
                  {SCOPES.map((s) => (
                    <label key={s}>
                      <input
                        type="checkbox"
                        checked={scopes.includes(s)}
                        onChange={() => setScopes(toggle(scopes, s))}
                      />
                      <span>{he.scopes[s] ?? s}</span>
                    </label>
                  ))}
                </div>
                {errors.scopes ? <span className="hint err">{errors.scopes}</span> : null}
              </fieldset>
              {scopes.includes('relay') ? (
                <div className="field">
                  <label htmlFor="k-conv">{K.conversations}</label>
                  <textarea
                    id="k-conv"
                    className="ta num"
                    dir="ltr"
                    value={convs}
                    onChange={(e) => setConvs(e.target.value)}
                  />
                  <span className={errors.conversationIds ? 'hint err' : 'hint'}>
                    {K.conversationsHint}
                  </span>
                </div>
              ) : null}
              <div className="field">
                <label htmlFor="k-exp">{K.expires}</label>
                <input
                  id="k-exp"
                  type="date"
                  className="sel"
                  value={expires}
                  onChange={(e) => setExpires(e.target.value)}
                  style={{ maxWidth: 220 }}
                />
              </div>
              <div className="row-acts">
                <button type="submit" className="btn primary">
                  {K.create}
                </button>
                <button type="button" className="btn quiet" onClick={() => setCreating(false)}>
                  {he.app.cancel}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={create} noValidate>
              <div className="gate" style={{ marginTop: 16 }}>
                <Icon name="key" />
                <div>
                  <strong>{K.reauthTitle}</strong>
                  <p>{K.reauthBody}</p>
                </div>
              </div>
              <div className="field">
                <label htmlFor="k-pw">{K.password}</label>
                <div className="inp">
                  <input
                    id="k-pw"
                    ref={pwRef}
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    dir="ltr"
                    required
                  />
                </div>
              </div>
              <div className="row-acts">
                <button
                  type="submit"
                  className="btn primary"
                  disabled={pending}
                  aria-busy={pending}
                >
                  {pending ? K.creating : K.confirmCreate}
                </button>
                <button type="button" className="btn quiet" onClick={() => setStep('form')}>
                  {he.app.back}
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}

      <div aria-live="polite" role="status">
        {msg ? <p className={msg.ok ? 'msg ok' : 'msg bad'}>{msg.text}</p> : null}
        {msg?.code ? <WhatToCheck codes={[msg.code]} /> : null}
      </div>

      {keys.length === 0 ? (
        <div className="empty">
          <strong>{K.listTitle}</strong>
          <p>{K.empty}</p>
        </div>
      ) : (
        <section className="card">
          <ul className="rows" style={{ marginTop: 0 }}>
            {keys.map((k) => {
              const revoked = !!k.revokedAt;
              const expired = !revoked && !!k.expiresAt && Date.parse(k.expiresAt) < now;
              return (
                <li key={k.id} className={revoked || expired ? 'keycard revoked' : 'keycard'}>
                  <div>
                    <strong>{k.name}</strong>{' '}
                    {revoked ? (
                      <span className="pill">{K.revoked}</span>
                    ) : expired ? (
                      <span className="pill">{K.expired}</span>
                    ) : null}
                    {k.legacy && !revoked ? <span className="tag-warn">{K.legacy}</span> : null}
                    <small>
                      {K.prefix}
                      <Num>{k.prefix}</Num> · {K.created}
                      <Num>{formatDateTime(k.createdAt)}</Num> ·{' '}
                      {k.lastUsedAt ? (
                        <>
                          {K.lastUsed}
                          <Num>{formatDateTime(k.lastUsedAt)}</Num>
                        </>
                      ) : (
                        K.neverUsed
                      )}
                      {k.expiresAt ? (
                        <>
                          {' · '}
                          {K.expiresAt}
                          <Num>{formatDateTime(k.expiresAt)}</Num>
                        </>
                      ) : null}
                    </small>
                    <div className="caps">
                      {k.scopes.map((s) => (
                        <span key={s}>{he.scopes[s] ?? s}</span>
                      ))}
                      {(k.accountIds.length ? k.accountIds.map(accLabel) : [K.allAccounts]).map(
                        (l) => (
                          <span key={l} className="no">
                            {l}
                          </span>
                        ),
                      )}
                    </div>
                  </div>
                  <div className="acts">
                    {!revoked ? (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => setConfirmRevoke(k.id)}
                      >
                        {K.revoke}
                      </button>
                    ) : null}
                  </div>
                  {confirmRevoke === k.id ? (
                    <div
                      className="confirm"
                      role="alertdialog"
                      aria-label={K.revokeConfirm(k.name)}
                    >
                      <p>
                        <strong>{K.revokeConfirm(k.name)}</strong> {K.revokeBody}
                      </p>
                      <button
                        type="button"
                        className="btn quiet"
                        onClick={() => setConfirmRevoke(null)}
                      >
                        {he.app.keep}
                      </button>
                      <button
                        type="button"
                        className="btn danger"
                        onClick={() => revoke(k.id)}
                        disabled={pending}
                      >
                        {K.revokeYes}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
