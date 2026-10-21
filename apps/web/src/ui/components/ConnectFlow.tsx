'use client';

import Link from 'next/link';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  createAccount,
  getPairingState,
  saveCloudCredentials,
  sendTestMessage,
  startPairing,
  type PairingState,
} from '@/server/actions/connect';
import type { CloudCredentialsView } from '@/server/actions/read-models';
import { he } from '../i18n/he';
import { correctPhone } from '../lib/phone';
import { formatCountdown } from '../lib/time';
import { CopyButton, useAction, WhatToCheck } from './client';
import { Icon, Num } from './Icon';

export type Method = 'qr' | 'pairing' | 'cloud';
type Provider = 'baileys' | 'meta_cloud';

export interface ConnectAccount {
  id: string;
  provider: Provider;
  label: string;
  phoneDisplay: string | null;
}

const C = he.connect;
const POLL_MS = 2000;
const TERMINAL = new Set<PairingState['state']>(['paired', 'expired', 'failed', 'cancelled']);

function useTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Polls getPairingState every ~2 s while the request is live (C2/C3). Nothing is cached. */
function usePairing(requestId: string | null) {
  const act = useAction();
  const [state, setState] = useState<PairingState | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    setState(null);
    setError(null);
    if (!requestId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await act(() => getPairingState(requestId));
      if (cancelled) return;
      if (r.ok) {
        setState(r.data);
        setError(null);
        if (TERMINAL.has(r.data.state)) return;
      } else {
        setError({ code: r.code, message: r.message_he });
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [requestId, act]);
  return { state, error };
}

function setUrl(accountId: string | null, method: Method) {
  const p = new URLSearchParams();
  if (accountId) p.set('account', accountId);
  p.set('method', method);
  window.history.replaceState(null, '', `/connect?${p.toString()}`);
}

export function ConnectFlow({
  account,
  initialMethod,
  webhookUrl,
  credentials,
  webhookUrlChanged,
}: {
  account: ConnectAccount | null;
  initialMethod: Method;
  webhookUrl: string | null;
  credentials: CloudCredentialsView | null;
  webhookUrlChanged: boolean;
}) {
  const fixedProvider = account?.provider ?? null;
  const [provider, setProvider] = useState<Provider>(
    fixedProvider ?? (initialMethod === 'cloud' ? 'meta_cloud' : 'baileys'),
  );
  const [method, setMethod] = useState<'qr' | 'pairing'>(
    initialMethod === 'pairing' ? 'pairing' : 'qr',
  );
  const [accountId, setAccountId] = useState<string | null>(account?.id ?? null);
  const [label, setLabel] = useState(account?.label ?? '');
  const [labelError, setLabelError] = useState<string | null>(null);
  const act = useAction();

  const chooseProvider = (p: Provider) => {
    if (fixedProvider) return;
    setProvider(p);
    setUrl(accountId, p === 'meta_cloud' ? 'cloud' : method);
  };
  const chooseMethod = (m: 'qr' | 'pairing') => {
    setMethod(m);
    setUrl(accountId, m);
  };

  /** Creates the account row once (owner + AAL2), then reuses it on retries. */
  const ensureAccount = async (
    p: Provider,
  ): Promise<{ ok: true; id: string } | { ok: false; message: string }> => {
    if (accountId) return { ok: true, id: accountId };
    if (!label.trim()) {
      setLabelError(C.nameRequired);
      return { ok: false, message: C.nameRequired };
    }
    setLabelError(null);
    const r = await act(() => createAccount({ provider: p, label: label.trim() }));
    if (!r.ok) {
      if (r.fields?.label) setLabelError(C.nameRequired);
      return { ok: false, message: r.message_he };
    }
    setAccountId(r.data.accountId);
    setUrl(r.data.accountId, p === 'meta_cloud' ? 'cloud' : method);
    return { ok: true, id: r.data.accountId };
  };

  const nameField = (
    <div className="field">
      <label htmlFor="acc-name">{C.name}</label>
      <div className={labelError ? 'inp err' : 'inp'}>
        <input
          id="acc-name"
          value={label}
          placeholder={C.namePlaceholder}
          onChange={(e) => setLabel(e.target.value)}
          readOnly={!!accountId}
          aria-invalid={!!labelError}
          aria-describedby={labelError ? 'acc-name-err' : undefined}
          maxLength={80}
        />
      </div>
      {labelError ? (
        <span className="hint err" id="acc-name-err">
          {labelError}
        </span>
      ) : null}
    </div>
  );

  return (
    <>
      <div className="choice" role="radiogroup" aria-label={C.choiceLabel}>
        <label>
          <input
            type="radio"
            name="provider"
            checked={provider === 'baileys'}
            disabled={!!fixedProvider && fixedProvider !== 'baileys'}
            onChange={() => chooseProvider('baileys')}
          />
          <strong>{C.baileysTitle}</strong>
          <span className="tagline">{C.baileysTag}</span>
          <ul>
            {C.baileysYes.map((t) => (
              <li className="y" key={t}>
                <Icon name="check" />
                {t}
              </li>
            ))}
            {C.baileysNo.map((t) => (
              <li className="n" key={t}>
                <Icon name="x" />
                {t}
              </li>
            ))}
          </ul>
        </label>
        <label>
          <input
            type="radio"
            name="provider"
            checked={provider === 'meta_cloud'}
            disabled={!!fixedProvider && fixedProvider !== 'meta_cloud'}
            onChange={() => chooseProvider('meta_cloud')}
          />
          <strong>{C.cloudTitle}</strong>
          <span className="tagline">{C.cloudTag}</span>
          <ul>
            {C.cloudYes.map((t) => (
              <li className="y" key={t}>
                <Icon name="check" />
                {t}
              </li>
            ))}
            {C.cloudNo.map((t) => (
              <li className="n" key={t}>
                <Icon name="x" />
                {t}
              </li>
            ))}
          </ul>
          <p className="meta-warn">
            <Icon name="alert" />
            <span>{C.metaPolicy}</span>
          </p>
        </label>
      </div>
      {fixedProvider ? (
        <p className="uses" style={{ marginTop: 8 }}>
          {C.providerLocked}
        </p>
      ) : null}

      {provider === 'baileys' ? (
        <section className="form" aria-labelledby="bf">
          <h3 id="bf" style={{ fontSize: 18, fontWeight: 600 }}>
            {C.baileysForm}
          </h3>
          {nameField}
          <div className="tabs" role="tablist" aria-label={C.methodLabel}>
            <button
              type="button"
              role="tab"
              id="tab-qr"
              aria-controls="pane-baileys"
              aria-selected={method === 'qr'}
              onClick={() => chooseMethod('qr')}
            >
              {C.tabQr}
            </button>
            <button
              type="button"
              role="tab"
              id="tab-pair"
              aria-controls="pane-baileys"
              aria-selected={method === 'pairing'}
              onClick={() => chooseMethod('pairing')}
            >
              {C.tabPair}
            </button>
          </div>
          <div
            className="pane"
            role="tabpanel"
            id="pane-baileys"
            aria-labelledby={method === 'qr' ? 'tab-qr' : 'tab-pair'}
          >
            {method === 'qr' ? (
              <QrPane
                key="qr"
                ensureAccount={() => ensureAccount('baileys')}
                accountId={accountId}
                onUsePair={() => chooseMethod('pairing')}
              />
            ) : (
              <PairPane
                key="pair"
                ensureAccount={() => ensureAccount('baileys')}
                accountId={accountId}
              />
            )}
          </div>
        </section>
      ) : (
        <CloudForm
          nameField={nameField}
          ensureAccount={() => ensureAccount('meta_cloud')}
          accountId={accountId}
          webhookUrl={webhookUrl}
          credentials={credentials}
          webhookUrlChanged={webhookUrlChanged}
        />
      )}
    </>
  );
}

type Ensure = () => Promise<{ ok: true; id: string } | { ok: false; message: string }>;

function Failure({
  title,
  body,
  codes,
  onRetry,
}: {
  title: string;
  body: string;
  codes: string[];
  onRetry: () => void;
}) {
  return (
    <div className="res bad" style={{ marginTop: 16 }}>
      <span className="ic">
        <Icon name="alert" style={{ width: 16, height: 16 }} />
      </span>
      <strong>{title}</strong>
      <p>{body}</p>
      <div className="acts">
        <button type="button" className="btn primary" onClick={onRetry}>
          <Icon name="refresh" />
          {C.newCode}
        </button>
      </div>
      <WhatToCheck codes={codes} />
    </div>
  );
}

function QrPane({
  ensureAccount,
  accountId,
  onUsePair,
}: {
  ensureAccount: Ensure;
  accountId: string | null;
  onUsePair: () => void;
}) {
  const act = useAction();
  const [pending, start] = useTransition();
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const { state, error: pollError } = usePairing(requestId);
  const live = !!state && !TERMINAL.has(state.state);
  const now = useTick(live);

  const begin = () =>
    start(async () => {
      setError(null);
      const acc = await ensureAccount();
      if (!acc.ok) {
        setError({ message: acc.message, code: 'account' });
        return;
      }
      const r = await act(() => startPairing({ accountId: acc.id, method: 'qr' }));
      if (!r.ok) setError({ message: r.message_he, code: r.code });
      else setRequestId(r.data.requestId);
    });

  if (state?.state === 'paired' && accountId) return <Paired accountId={accountId} phone={null} />;
  if (state && TERMINAL.has(state.state)) {
    return state.state === 'expired' || state.state === 'cancelled' ? (
      <Failure title={C.expiredTitle} body={C.expiredBody} codes={[state.state]} onRetry={begin} />
    ) : (
      <Failure title={C.failedTitle} body={C.failedBody} codes={[state.state]} onRetry={begin} />
    );
  }

  const qrLeft = state?.qrExpiresAt ? Date.parse(state.qrExpiresAt) - now : null;
  const stale = qrLeft !== null && qrLeft <= 0;
  return (
    <>
      {requestId ? (
        <div className="qrbox">
          {state?.qrSvg ? (
            <div
              className={stale ? 'qr stale' : 'qr'}
              role="img"
              aria-label={C.qrAlt}
              // Server-generated SVG markup (qrcode lib) for the owner only; never cached.
              dangerouslySetInnerHTML={{ __html: state.qrSvg }}
            />
          ) : (
            <div className="qr placeholder" role="img" aria-label={C.qrPreparing}>
              <span>
                <Icon name="refresh" className="spin" />
                <br />
                {C.qrPreparing}
              </span>
            </div>
          )}
          <div className="qrmeta" aria-live="polite">
            <span className="conn">
              <i style={{ background: 'var(--warn)' }} />
              {C.waitingScan}
            </span>
            {qrLeft !== null && qrLeft > 0 ? (
              <span className="uses">
                {C.qrRefreshIn}
                <Num>{Math.ceil(qrLeft / 1000)}s</Num>
              </span>
            ) : state?.requestExpiresAt ? (
              <span className="uses">
                {C.requestLeft}
                <Num>{formatCountdown(Date.parse(state.requestExpiresAt) - now)}</Num>
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn primary"
          onClick={begin}
          disabled={pending}
          aria-busy={pending}
        >
          <Icon name="link" />
          {pending ? C.starting : C.startQr}
        </button>
      )}
      <div aria-live="polite" role="status">
        {error ? <p className="msg bad">{error.message}</p> : null}
        {pollError ? <p className="msg bad">{pollError.message}</p> : null}
      </div>
      <ol className="howto">
        {C.howQr.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ol>
      <p className="uses" style={{ marginTop: 12 }}>
        {C.qrPrivacy}
      </p>
      <p className="uses" style={{ marginTop: 6 }}>
        {C.noCamera}{' '}
        <button
          type="button"
          className="inp-link"
          onClick={onUsePair}
          style={{
            color: 'var(--brand)',
            fontWeight: 500,
            background: 'none',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          {C.usePair}
        </button>
      </p>
    </>
  );
}

function PhoneField({
  id,
  label,
  value,
  onChange,
  serverError,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  serverError?: string | null | undefined;
  hint?: string | undefined;
}) {
  const c = correctPhone(value);
  const bad = c.state === 'invalid' || !!serverError;
  return (
    <div className="field" style={{ marginTop: 0 }}>
      <label htmlFor={id}>{label}</label>
      <div className={bad ? 'inp err' : 'inp'}>
        <input
          id={id}
          className="num"
          style={{ textAlign: 'left' }}
          dir="ltr"
          inputMode="tel"
          autoComplete="tel"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={bad}
          aria-describedby={`${id}-s`}
        />
      </div>
      <span id={`${id}-s`} aria-live="polite">
        {c.state === 'corrected' ? (
          <span className="norm">
            <Icon name="check" />
            {C.willSaveAs}
            <Num>{c.display}</Num>
          </span>
        ) : c.state === 'invalid' || serverError ? (
          <span className="hint err">{serverError ?? C.phoneInvalid}</span>
        ) : hint ? (
          <span className="hint">{hint}</span>
        ) : null}
      </span>
    </div>
  );
}

function PairPane({
  ensureAccount,
  accountId,
}: {
  ensureAccount: Ensure;
  accountId: string | null;
}) {
  const act = useAction();
  const [pending, start] = useTransition();
  const [phone, setPhone] = useState('');
  const [req, setReq] = useState<{ requestId: string; phoneDisplay: string | null } | null>(null);
  const [error, setError] = useState<{ message: string; field: boolean } | null>(null);
  const { state, error: pollError } = usePairing(req?.requestId ?? null);
  const live = !!state && !TERMINAL.has(state.state);
  const now = useTick(live);

  const begin = () =>
    start(async () => {
      setError(null);
      const c = correctPhone(phone);
      if (c.state !== 'corrected') {
        setError({ message: C.phoneInvalid, field: true });
        return;
      }
      const acc = await ensureAccount();
      if (!acc.ok) {
        setError({ message: acc.message, field: false });
        return;
      }
      const r = await act(() => startPairing({ accountId: acc.id, method: 'code', phone: c.e164 }));
      if (!r.ok) setError({ message: r.message_he, field: !!r.fields?.phone });
      else setReq({ requestId: r.data.requestId, phoneDisplay: r.data.phoneDisplay });
    });

  if (state?.state === 'paired' && accountId)
    return <Paired accountId={accountId} phone={req?.phoneDisplay ?? null} />;

  const code = state?.pairingCode?.replace(/[^A-Za-z0-9]/g, '') ?? null;
  return (
    <>
      <PhoneField
        id="pair-phone"
        label={C.phone}
        value={phone}
        onChange={(v) => {
          setPhone(v);
          if (error?.field) setError(null);
        }}
        serverError={error?.field ? error.message : null}
        hint={C.phoneHint}
      />
      {state && TERMINAL.has(state.state) ? (
        <Failure
          title={state.state === 'failed' ? C.failedTitle : C.expiredTitle}
          body={state.state === 'failed' ? C.failedBody : C.expiredBody}
          codes={[state.state]}
          onRetry={begin}
        />
      ) : req ? (
        <>
          {code ? (
            <div className="paircode" aria-label={C.pairLabel}>
              <Num>{code.slice(0, 4)}</Num>
              <Num>{code.slice(4)}</Num>
            </div>
          ) : (
            <p className="uses" style={{ textAlign: 'center', margin: '20px 0 10px' }}>
              <Icon name="refresh" className="spin" /> {C.codePreparing}
            </p>
          )}
          <div className="qrmeta" style={{ justifyContent: 'center' }} aria-live="polite">
            <span className="conn">
              <i style={{ background: 'var(--warn)' }} />
              {C.waitingType}
            </span>
            {state?.requestExpiresAt ? (
              <span className="uses">
                {C.validFor}
                <Num>{formatCountdown(Date.parse(state.requestExpiresAt) - now)}</Num>
              </span>
            ) : null}
          </div>
          <ol className="howto">
            {C.howPair.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
          <div className="row-acts" style={{ marginTop: 16 }}>
            <button type="button" className="btn" onClick={begin} disabled={pending}>
              {C.newCode}
            </button>
          </div>
        </>
      ) : (
        <div className="row-acts" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn primary"
            onClick={begin}
            disabled={pending}
            aria-busy={pending}
          >
            <Icon name="key" />
            {pending ? C.starting : C.getCode}
          </button>
        </div>
      )}
      <div aria-live="polite" role="status">
        {error && !error.field ? <p className="msg bad">{error.message}</p> : null}
        {pollError ? <p className="msg bad">{pollError.message}</p> : null}
      </div>
      <p className="state-label" style={{ marginTop: 22 }}>
        {C.pairPrivacy}
      </p>
    </>
  );
}

function Paired({ accountId, phone }: { accountId: string; phone: string | null }) {
  return (
    <div className="res ok" role="status">
      <span className="ic">
        <Icon name="check" style={{ width: 16, height: 16 }} />
      </span>
      <strong>{C.pairedTitle}</strong>
      <p>{C.pairedBody(phone)}</p>
      <TestMessage accountId={accountId} />
    </div>
  );
}

/** "שליחת הודעת בדיקה" CTA after connecting (same send gate as MCP). */
export function TestMessage({ accountId }: { accountId: string }) {
  const act = useAction();
  const [to, setTo] = useState('');
  const [text, setText] = useState<string>(C.testDefault);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string; code?: string } | null>(null);
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = correctPhone(to);
    start(async () => {
      const r = await act(() =>
        sendTestMessage({ accountId, to: c.state === 'corrected' ? c.e164 : to, text }),
      );
      if (r.ok) setMsg({ ok: true, text: r.data.status === 'sent' ? C.testSent : C.testQueued });
      else setMsg({ ok: false, text: r.message_he, code: r.code });
    });
  };
  return (
    <form onSubmit={submit} style={{ marginTop: 8 }}>
      <strong style={{ display: 'block', marginTop: 8 }}>{C.testTitle}</strong>
      <div style={{ marginTop: 10 }}>
        <PhoneField id={`${id}-to`} label={C.testTo} value={to} onChange={setTo} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-txt`}>{C.testText}</label>
        <div className="inp">
          <input
            id={`${id}-txt`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={4096}
          />
        </div>
      </div>
      <div className="acts">
        <button
          className="btn primary"
          type="submit"
          disabled={pending || correctPhone(to).state !== 'corrected'}
        >
          <Icon name="send" />
          {pending ? he.actions.working : C.testSend}
        </button>
        <Link className="btn" href={`/numbers/${accountId}`}>
          {C.toNumber}
        </Link>
      </div>
      <div aria-live="polite" role="status">
        {msg ? <p className={msg.ok ? 'msg ok' : 'msg bad'}>{msg.text}</p> : null}
        {msg?.code ? <WhatToCheck codes={[msg.code]} /> : null}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ Cloud API */

type CloudField = 'phoneNumberId' | 'wabaId' | 'accessToken' | 'appSecret' | 'verifyToken';

function randomVerifyToken(): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return `vt_${Array.from(bytes, (b) => abc[b % abc.length]).join('')}`;
}

interface SavedView {
  phoneNumberId: string | null;
  wabaId: string | null;
  tokenLast4: string | null;
  appSecretLast4: string | null;
  verifyTokenLast4: string | null;
  displayPhone: string | null;
  verifiedName: string | null;
}

const masked = (last4: string | null) => `•••••••••••••••• ${last4 ?? ''}`.trim();

function CloudForm({
  nameField,
  ensureAccount,
  accountId,
  webhookUrl,
  credentials,
  webhookUrlChanged,
}: {
  nameField: ReactNode;
  ensureAccount: Ensure;
  accountId: string | null;
  webhookUrl: string | null;
  credentials: CloudCredentialsView | null;
  webhookUrlChanged: boolean;
}) {
  const act = useAction();
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState<SavedView | null>(
    credentials
      ? {
          phoneNumberId: credentials.phoneNumberId,
          wabaId: credentials.wabaId,
          tokenLast4: credentials.tokenLast4,
          appSecretLast4: credentials.appSecretLast4,
          verifyTokenLast4: credentials.verifyTokenLast4,
          displayPhone: null,
          verifiedName: null,
        }
      : null,
  );
  const [editing, setEditing] = useState(!credentials);
  const [justSaved, setJustSaved] = useState(false);
  const [values, setValues] = useState<Record<CloudField, string>>({
    phoneNumberId: credentials?.phoneNumberId ?? '',
    wabaId: credentials?.wabaId ?? '',
    accessToken: '',
    appSecret: '',
    verifyToken: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<CloudField, string>>>({});
  const [formError, setFormError] = useState<{ message: string; code: string } | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    if (editing && !values.verifyToken)
      setValues((v) => ({ ...v, verifyToken: randomVerifyToken() }));
  }, [editing, values.verifyToken]);

  const set = (k: CloudField, v: string) => {
    setValues((s) => ({ ...s, [k]: v }));
    if (fieldErrors[k]) setFieldErrors((f) => ({ ...f, [k]: undefined }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const missing: Partial<Record<CloudField, string>> = {};
    (Object.keys(values) as CloudField[]).forEach((k) => {
      if (!values[k].trim()) missing[k] = C.required;
    });
    if (Object.keys(missing).length) {
      setFieldErrors(missing);
      setFocusTick((t) => t + 1);
      return;
    }
    start(async () => {
      setFormError(null);
      setFieldErrors({});
      const acc = await ensureAccount();
      if (!acc.ok) {
        setFormError({ message: acc.message, code: 'account' });
        return;
      }
      const r = await act(() =>
        saveCloudCredentials({
          accountId: acc.id,
          phoneNumberId: values.phoneNumberId.trim(),
          wabaId: values.wabaId.trim(),
          accessToken: values.accessToken.trim(),
          appSecret: values.appSecret.trim(),
          verifyToken: values.verifyToken.trim(),
        }),
      );
      if (!r.ok) {
        const fe: Partial<Record<CloudField, string>> = {};
        const mapped = he.cloudFieldErrors[r.code];
        if (mapped) fe[mapped.field as CloudField] = mapped.text;
        for (const k of Object.keys(r.fields ?? {})) {
          if (k in values) fe[k as CloudField] ??= C.invalidValue;
        }
        setFieldErrors(fe);
        setFormError({ message: r.message_he, code: r.code });
        setFocusTick((t) => t + 1);
        return;
      }
      // Secrets leave client state right away; only last 4 are shown from now on (C5).
      setValues({
        phoneNumberId: r.data.phoneNumberId,
        wabaId: r.data.wabaId,
        accessToken: '',
        appSecret: '',
        verifyToken: '',
      });
      setSaved({
        phoneNumberId: r.data.phoneNumberId,
        wabaId: r.data.wabaId,
        tokenLast4: r.data.tokenLast4,
        appSecretLast4: r.data.appSecretLast4,
        verifyTokenLast4: r.data.verifyTokenLast4,
        displayPhone: r.data.displayPhoneNumber,
        verifiedName: r.data.verifiedName,
      });
      setEditing(false);
      setJustSaved(true);
    });
  };

  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
  }, [focusTick]);

  const field = (
    k: CloudField,
    label: string,
    hint: string,
    okBadge: string | null,
    opts: { secret?: boolean; generate?: boolean } = {},
  ) => {
    const err = fieldErrors[k];
    const showMasked = !editing && saved && (opts.secret ?? false);
    const last4 =
      k === 'accessToken'
        ? saved?.tokenLast4
        : k === 'appSecret'
          ? saved?.appSecretLast4
          : k === 'verifyToken'
            ? saved?.verifyTokenLast4
            : null;
    const hintId = `${k}-hint`;
    return (
      <div className="field" key={k}>
        <label htmlFor={k}>{label}</label>
        <div className={err ? 'inp err' : showMasked ? 'inp masked' : 'inp'}>
          {showMasked ? (
            <input
              id={k}
              className="num"
              style={{ textAlign: 'left' }}
              dir="ltr"
              value={masked(last4 ?? null)}
              readOnly
              aria-describedby={hintId}
            />
          ) : (
            <input
              id={k}
              className="num"
              style={{ textAlign: 'left' }}
              dir="ltr"
              value={values[k]}
              onChange={(e) => set(k, e.target.value)}
              readOnly={!editing}
              autoComplete="off"
              spellCheck={false}
              type={opts.secret && k !== 'verifyToken' ? 'password' : 'text'}
              aria-invalid={!!err}
              aria-describedby={hintId}
            />
          )}
          {err ? (
            <span className="bad">
              <Icon name="alert" />
              {err}
            </span>
          ) : !editing && okBadge ? (
            <span className="ok">
              <Icon name="check" />
              {okBadge}
            </span>
          ) : null}
          {editing && opts.generate ? (
            <>
              <button
                type="button"
                className="lnk"
                onClick={() => set('verifyToken', randomVerifyToken())}
              >
                {C.regenerate}
              </button>
              <CopyButton value={values.verifyToken} className="btn" style={{ height: 30 }} />
            </>
          ) : null}
        </div>
        <span className={err ? 'hint err' : 'hint'} id={hintId}>
          {err ? (he.cloudFieldHints[k] ?? hint) : hint}
        </span>
      </div>
    );
  };

  return (
    <section className="form" aria-labelledby="cf">
      <h3 id="cf" style={{ fontSize: 18, fontWeight: 600 }}>
        {C.cloudForm}
      </h3>
      <form ref={formRef} onSubmit={submit} noValidate>
        {nameField}
        <div className="grid2">
          {field(
            'phoneNumberId',
            C.phoneNumberId,
            saved?.displayPhone
              ? C.phoneFound(saved.displayPhone, saved.verifiedName)
              : C.hintPhoneId,
            C.found,
          )}
          {field('wabaId', C.wabaId, C.hintWaba, C.matches)}
        </div>
        {field('accessToken', C.accessToken, C.hintToken, C.tokenOk, { secret: true })}
        {field('appSecret', C.appSecret, C.hintSecret, C.stored, { secret: true })}
        {field('verifyToken', C.verifyToken, C.hintVerify, C.stored, {
          secret: true,
          generate: true,
        })}
        {webhookUrl ? (
          <div className="field">
            <label>{C.webhookLabel}</label>
            <div className="copyrow">
              <span className="num">{webhookUrl}</span>
              <CopyButton value={webhookUrl} style={{ height: 32 }} />
            </div>
            <span className="hint">{C.webhookHint}</span>
          </div>
        ) : null}
        {webhookUrlChanged && credentials?.verifiedWebhookUrl && webhookUrl ? (
          <div className="res warn" role="status" style={{ marginTop: 16 }}>
            <span className="ic">
              <Icon name="alert" style={{ width: 16, height: 16 }} />
            </span>
            <strong>{C.urlChangedTitle}</strong>
            <p>{C.urlChangedBody}</p>
            <div
              className="kv"
              style={{
                marginTop: 8,
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: '4px 12px',
                fontSize: 13,
              }}
            >
              <span className="sub">{C.urlSaved}</span>
              <span
                className="num"
                dir="ltr"
                style={{ textDecoration: 'line-through', opacity: 0.6, overflowWrap: 'anywhere' }}
              >
                {credentials.verifiedWebhookUrl}
              </span>
              <span className="sub">{C.urlCurrent}</span>
              <span className="num" dir="ltr" style={{ overflowWrap: 'anywhere' }}>
                {webhookUrl}
              </span>
            </div>
            <div className="acts">
              <CopyButton value={webhookUrl} label={C.copyNew} className="btn primary" />
              <button type="button" className="btn" onClick={() => window.location.reload()}>
                {C.recheck}
              </button>
            </div>
          </div>
        ) : null}
        <div aria-live="polite" role="status">
          {formError ? (
            <div className="res bad" style={{ marginTop: 16 }}>
              <span className="ic">
                <Icon name="alert" style={{ width: 16, height: 16 }} />
              </span>
              <strong>{formError.message}</strong>
              <WhatToCheck codes={[formError.code]} />
            </div>
          ) : null}
          {justSaved && accountId ? (
            <div className="res ok" style={{ marginTop: 16 }}>
              <span className="ic">
                <Icon name="check" style={{ width: 16, height: 16 }} />
              </span>
              <strong>{C.cloudSavedTitle}</strong>
              <p>{C.cloudSavedBody}</p>
              <TestMessage accountId={accountId} />
            </div>
          ) : null}
        </div>
        <div className="row-acts">
          {editing ? (
            <button className="btn primary" type="submit" disabled={pending} aria-busy={pending}>
              {pending ? C.checking : saved ? C.submitCloudSaved : C.submitCloud}
            </button>
          ) : (
            <button
              className="btn"
              type="button"
              onClick={() => {
                setEditing(true);
                setJustSaved(false);
              }}
            >
              {he.number.credsEdit}
            </button>
          )}
          <Link className="btn quiet" href={accountId ? `/numbers/${accountId}` : '/'}>
            {he.app.back}
          </Link>
        </div>
      </form>
    </section>
  );
}
