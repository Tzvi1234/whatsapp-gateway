'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';
import { LIA_NO_REPLY_THRESHOLDS_MIN, type LiaTestResult } from '@htz/core';
import { getLiaChannel } from '@/server/actions/read-models';
import {
  resendRelayBatch,
  saveRelayTarget,
  sendLiaTest,
  updateAllowlist,
  type RelayTargetView,
} from '@/server/actions/relay';
import type { AllowlistAuditEntry } from '@/server/actions/dashboard-extra';
import { he } from '../i18n/he';
import { liaResultView, resClass, type LiaAction } from '../lib/lia-status';
import { correctPhone } from '../lib/phone';
import { formatDateTime } from '../lib/time';
import { useAction, WhatToCheck } from './client';
import { Icon, Num } from './Icon';

const L = he.lia;
const POLL_MS = 5000;

export function LiaSetup({
  accountId,
  provider,
  phoneDisplay,
  initialTarget,
  latestTestBatchId,
  audit,
}: {
  accountId: string;
  provider: 'baileys' | 'meta_cloud';
  phoneDisplay: string | null;
  initialTarget: RelayTargetView | null;
  latestTestBatchId: string | null;
  audit: AllowlistAuditEntry[] | null;
}) {
  const router = useRouter();
  const act = useAction();
  const [target, setTarget] = useState<RelayTargetView | null>(initialTarget);
  const [url, setUrl] = useState('');
  const [keyEditing, setKeyEditing] = useState(!initialTarget?.secretLast4);
  const [key, setKey] = useState('');
  const [threshold, setThreshold] = useState<number>(initialTarget?.noReplyThresholdMin ?? 10);
  const [fieldErr, setFieldErr] = useState<{ url?: string; secret?: string }>({});
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string; code?: string } | null>(null);
  const [pending, start] = useTransition();
  const [phase, setPhase] = useState<'sending' | 'retrying' | null>(null);
  const [test, setTest] = useState<LiaTestResult | null>(initialTarget?.lastTest ?? null);
  const [batchId, setBatchId] = useState<string | null>(latestTestBatchId);
  const [polling, setPolling] = useState(initialTarget?.lastTest?.status === 'accepted');
  const keyRef = useRef<HTMLInputElement>(null);

  const thresholdMin = target?.noReplyThresholdMin ?? threshold;

  // While a test is `accepted`, keep listening (L4.2): poll the channel until it changes.
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const deadline = Date.now() + (thresholdMin + 1) * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await act(() => getLiaChannel(accountId));
      if (cancelled) return;
      if (r.ok && r.data.target) {
        setTarget(r.data.target);
        const lt = r.data.target.lastTest;
        setTest(lt);
        if (lt && lt.status !== 'accepted') {
          setPolling(false);
          setPhase(null);
          router.refresh();
          return;
        }
        if (lt) setPhase((p) => (p === 'retrying' ? null : p));
      }
      if (Date.now() < deadline) timer = setTimeout(tick, POLL_MS);
      else setPolling(false);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [polling, accountId, act, router, thresholdMin]);

  const dirty =
    url.trim() !== '' || key.trim() !== '' || threshold !== (target?.noReplyThresholdMin ?? 10);

  /** Saves URL / key / threshold. URL is required by the action on every save. */
  const save = async (): Promise<RelayTargetView | null> => {
    const errs: { url?: string; secret?: string } = {};
    if (!url.trim()) errs.url = L.urlRequired;
    if (!target?.secretLast4 && !key.trim()) errs.secret = L.secretRequired;
    setFieldErr(errs);
    if (errs.url || errs.secret) return null;
    const r = await act(() =>
      saveRelayTarget({
        accountId,
        url: url.trim(),
        ...(key.trim() ? { secret: key.trim() } : {}),
        noReplyThresholdMin: threshold as 5 | 10 | 30,
      }),
    );
    if (!r.ok) {
      setFieldErr({
        ...(r.fields?.url ? { url: r.fields.url } : {}),
        ...(r.fields?.secret ? { secret: r.fields.secret } : {}),
      });
      setFormMsg({ ok: false, text: r.message_he, code: r.code });
      return null;
    }
    // The key never comes back; drop it from state and show only the last 4 (L5.6).
    setKey('');
    setKeyEditing(false);
    setUrl('');
    setTarget(r.data);
    setTest(r.data.lastTest);
    return r.data;
  };

  const runTest = () =>
    start(async () => {
      setFormMsg(null);
      let t = target;
      if (!t || dirty) {
        t = await save();
        if (!t) return;
      }
      setPhase('sending');
      const r = await act(() => sendLiaTest(t.id));
      if (!r.ok) {
        setPhase(null);
        setFormMsg({ ok: false, text: r.message_he, code: r.code });
        return;
      }
      setBatchId(r.data.batchId);
      setTest(r.data.lastTest);
      if (r.data.status === null) {
        setPhase('retrying');
        setPolling(true);
      } else {
        setPhase(null);
        if (r.data.status === 'accepted') setPolling(true);
      }
    });

  const saveOnly = (e?: FormEvent) => {
    e?.preventDefault();
    start(async () => {
      setFormMsg(null);
      const t = await save();
      if (t) {
        setFormMsg({ ok: true, text: L.saved });
        router.refresh();
      }
    });
  };

  const onAction = (k: LiaAction) => {
    if (k === 'finish') router.push(`/numbers/${accountId}`);
    else if (k === 'save_wait' || k === 'save_anyway') {
      if (dirty) saveOnly();
      else setFormMsg({ ok: true, text: L.saved });
    } else if (k === 'replace_key') {
      setKeyEditing(true);
      setTimeout(() => keyRef.current?.focus(), 0);
    } else if (k === 'retry') runTest();
    else if (k === 'resend' && batchId) {
      start(async () => {
        const r = await act(() => resendRelayBatch(batchId));
        if (r.ok) {
          setFormMsg({ ok: true, text: he.actions.resendLiaSent });
          setPhase('retrying');
          setPolling(true);
        } else setFormMsg({ ok: false, text: r.message_he, code: r.code });
      });
    }
  };

  const view = liaResultView(test, { thresholdMin, phase });
  const step = !target ? 1 : target.channel === 'untested' ? 2 : 3;

  return (
    <section className="card">
      <ol className="steps3" aria-label={L.stepsLabel(step)}>
        <li className={step > 1 ? 'done' : 'on'} aria-current={step === 1 ? 'step' : undefined}>
          <i />
          {L.stepDetails}
        </li>
        <li
          className={step > 2 ? 'done' : step === 2 ? 'on' : undefined}
          aria-current={step === 2 ? 'step' : undefined}
        >
          <i />
          {L.stepTest}
        </li>
        <li
          className={step === 3 ? 'done' : undefined}
          aria-current={step === 3 ? 'step' : undefined}
        >
          <i />
          {L.stepSave}
        </li>
      </ol>
      <div className="setup">
        <form onSubmit={saveOnly} noValidate>
          <h3 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-.015em' }}>{L.formTitle}</h3>
          <p className="lead" style={{ fontSize: 14.5 }}>
            {L.formLead}
          </p>
          <div className="field">
            <label htmlFor="lia-url">{L.url}</label>
            <div className={fieldErr.url ? 'inp err' : 'inp'}>
              <input
                id="lia-url"
                className="num"
                style={{ textAlign: 'left' }}
                dir="ltr"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder={target?.urlMasked ?? 'https://'}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-invalid={!!fieldErr.url}
                aria-describedby="lia-url-h"
              />
            </div>
            <span className={fieldErr.url ? 'hint err' : 'hint'} id="lia-url-h">
              {fieldErr.url ?? (target ? L.urlSavedHint(target.urlMasked) : L.urlHint)}
            </span>
          </div>
          <div className="field">
            <label htmlFor="lia-key">{L.key}</label>
            {keyEditing || !target?.secretLast4 ? (
              <div className={fieldErr.secret ? 'inp err' : 'inp'}>
                <input
                  id="lia-key"
                  ref={keyRef}
                  className="num"
                  style={{ textAlign: 'left' }}
                  dir="ltr"
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  aria-invalid={!!fieldErr.secret}
                  aria-describedby="lia-key-h"
                />
                {target?.secretLast4 ? (
                  <button
                    type="button"
                    className="lnk"
                    onClick={() => {
                      setKey('');
                      setKeyEditing(false);
                    }}
                  >
                    {he.app.cancel}
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="inp masked">
                <input
                  id="lia-key"
                  className="num"
                  style={{ textAlign: 'left' }}
                  dir="ltr"
                  value={`•••••••••••••••• ${target.secretLast4}`}
                  readOnly
                  aria-describedby="lia-key-h"
                />
                <button type="button" className="lnk" onClick={() => onAction('replace_key')}>
                  {he.app.replace}
                </button>
              </div>
            )}
            <span className={fieldErr.secret ? 'hint err' : 'hint'} id="lia-key-h">
              {fieldErr.secret ?? (target?.secretLast4 ? L.keyHint : L.keyNewHint)}
            </span>
          </div>

          <AllowlistEditor
            relayTargetId={target?.id ?? null}
            allowlist={target?.allowlist ?? []}
            audit={audit}
          />

          {provider === 'baileys' ? (
            <p className="uses" style={{ marginTop: 14, lineHeight: 1.8 }}>
              <span className="prov" style={{ marginInlineEnd: 8 }}>
                {he.provider.baileys}
              </span>
              {phoneDisplay ? (
                <>
                  {L.recommendedPre}
                  <Num>{phoneDisplay}</Num>.
                </>
              ) : (
                L.recommendedNoPhone
              )}
            </p>
          ) : (
            <p className="meta-warn">
              <Icon name="alert" />
              <span>{he.connect.metaPolicy}</span>
            </p>
          )}

          <div className="field">
            <label htmlFor="lia-th">{L.threshold}</label>
            <select
              id="lia-th"
              className="sel"
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            >
              {LIA_NO_REPLY_THRESHOLDS_MIN.map((m) => (
                <option key={m} value={m}>
                  {L.minutes(m)}
                </option>
              ))}
            </select>
          </div>
          <div className="row-acts">
            <button
              type="button"
              className="btn primary"
              onClick={runTest}
              disabled={pending}
              aria-busy={pending}
            >
              <Icon name="send" />
              {L.sendTest}
            </button>
            <button type="submit" className="btn" disabled={pending}>
              {pending ? he.app.saving : L.saveNoTest}
            </button>
          </div>
          <p className="uses" style={{ marginTop: 10 }}>
            {L.saveNoTestNote}
          </p>
          <div aria-live="polite" role="status">
            {formMsg ? <p className={formMsg.ok ? 'msg ok' : 'msg bad'}>{formMsg.text}</p> : null}
            {formMsg?.code ? <WhatToCheck codes={[formMsg.code]} /> : null}
          </div>
        </form>
        <div>
          <p className="state-label">{L.resultLabel}</p>
          <div className={resClass(view.tone)} aria-live="polite" role="status">
            <span className="ic">
              <Icon
                name={view.icon}
                className={view.key === 'sending' || view.key === 'retrying' ? 'spin' : undefined}
                style={{ width: 16, height: 16 }}
              />
            </span>
            <strong>{view.title}</strong>
            {view.body ? <p>{view.body}</p> : null}
            {view.timeline.length ? (
              <ul className="timeline">
                {view.timeline.map((t) => (
                  <li key={t.label}>
                    <Icon name="check" className="check" />
                    {t.label}
                    <span className="t num">{t.value}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <WhatToCheck hint={view.check} codes={view.codes} />
            {view.actions.length ? (
              <div className="acts">
                {view.actions.map((x) =>
                  x.kind === 'rescan' ? (
                    <Link
                      key={x.kind}
                      className="btn primary"
                      href={`/connect?account=${accountId}&method=qr`}
                    >
                      <Icon name="refresh" />
                      {x.label}
                    </Link>
                  ) : (
                    <button
                      key={x.kind}
                      type="button"
                      className={x.primary ? 'btn primary' : 'btn'}
                      onClick={() => onAction(x.kind)}
                      disabled={pending || (x.kind === 'resend' && !batchId)}
                    >
                      {x.label}
                    </button>
                  ),
                )}
              </div>
            ) : null}
            {view.sub ? <p className="sub">{view.sub}</p> : null}
          </div>
        </div>
      </div>
      <div className="toggle">
        <span
          className="sw"
          role="switch"
          aria-checked="false"
          aria-disabled="true"
          aria-label={L.sonioxTitle}
        />
        <div style={{ flex: 1 }}>
          <strong>{L.sonioxTitle}</strong>
          <div className="uses">{L.sonioxBody}</div>
        </div>
      </div>
    </section>
  );
}

/** Allowlist with a confirmation step (L6.1) and the read-only audit trail. */
function AllowlistEditor({
  relayTargetId,
  allowlist,
  audit,
}: {
  relayTargetId: string | null;
  allowlist: { e164: string; display: string }[];
  audit: AllowlistAuditEntry[] | null;
}) {
  const router = useRouter();
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<string[]>(allowlist.map((x) => x.display));
  const [preview, setPreview] = useState<{
    before: string[];
    after: { e164: string; display: string }[];
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!editing) setRows(allowlist.map((x) => x.display));
  }, [allowlist, editing]);

  const review = () =>
    start(async () => {
      if (!relayTargetId) return;
      setMsg(null);
      const r = await act(() =>
        updateAllowlist({ relayTargetId, senders: rows, confirmed: false }),
      );
      if (!r.ok) {
        setErrors(r.fields ?? {});
        setMsg({ ok: false, text: r.message_he });
        return;
      }
      setErrors({});
      setPreview({ before: r.data.before, after: r.data.after });
    });

  const apply = () =>
    start(async () => {
      if (!relayTargetId) return;
      const r = await act(() => updateAllowlist({ relayTargetId, senders: rows, confirmed: true }));
      if (!r.ok) {
        setMsg({ ok: false, text: r.message_he });
        return;
      }
      setPreview(null);
      setEditing(false);
      setMsg({ ok: true, text: L.applied });
      router.refresh();
    });

  const added = preview ? preview.after.filter((x) => !preview.before.includes(x.e164)) : [];
  const removed = preview
    ? preview.before.filter((e) => !preview.after.some((x) => x.e164 === e))
    : [];
  const displayOf = (e164: string) => allowlist.find((x) => x.e164 === e164)?.display ?? e164;

  return (
    <div className="field">
      <label id="al-l">{L.allowlist}</label>
      {!editing ? (
        <>
          <div className="listed" aria-labelledby="al-l">
            {allowlist.length === 0 ? (
              <div className="inp masked">
                <span className="uses">{L.allowlistEmpty}</span>
              </div>
            ) : (
              allowlist.map((x) => (
                <div className="inp masked" key={x.e164}>
                  <Num>{x.display}</Num>
                </div>
              ))
            )}
          </div>
          <span className="hint">{relayTargetId ? L.allowlistHint : L.allowlistNeedsTarget}</span>
          <div>
            <button
              type="button"
              className="btn sm"
              style={{ marginTop: 6 }}
              disabled={!relayTargetId}
              onClick={() => setEditing(true)}
            >
              {L.change}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="listed" aria-labelledby="al-l">
            {rows.map((v, i) => {
              const c = correctPhone(v);
              const err = errors[`senders.${i}`];
              return (
                <div key={i}>
                  <div className={err || c.state === 'invalid' ? 'inp err' : 'inp'}>
                    <input
                      className="num"
                      style={{ textAlign: 'left' }}
                      dir="ltr"
                      inputMode="tel"
                      aria-label={`${L.allowlist} ${i + 1}`}
                      value={v}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          review();
                        }
                      }}
                      onChange={(e) => {
                        const next = [...rows];
                        next[i] = e.target.value;
                        setRows(next);
                        setPreview(null);
                      }}
                    />
                    <button
                      type="button"
                      className="iconbtn"
                      aria-label={L.removeNumber}
                      onClick={() => {
                        setRows(rows.filter((_, j) => j !== i));
                        setPreview(null);
                      }}
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                  {c.state === 'corrected' && c.changed ? (
                    <span className="norm">
                      <Icon name="check" />
                      {he.connect.willSaveAs}
                      <Num>{c.display}</Num>
                    </span>
                  ) : err || c.state === 'invalid' ? (
                    <span className="hint err">{err ?? he.connect.phoneInvalid}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="row-acts" style={{ marginTop: 8 }}>
            <button type="button" className="btn sm" onClick={() => setRows([...rows, ''])}>
              <Icon name="plus" />
              {L.addNumber}
            </button>
            <button type="button" className="btn sm primary" onClick={review} disabled={pending}>
              {L.reviewChange}
            </button>
            <button
              type="button"
              className="btn sm quiet"
              onClick={() => {
                setEditing(false);
                setPreview(null);
                setErrors({});
              }}
            >
              {he.app.cancel}
            </button>
          </div>
        </>
      )}
      {preview ? (
        <div
          className="confirm neutral"
          role="alertdialog"
          aria-label={L.confirmTitle}
          style={{ marginTop: 6 }}
        >
          <p>
            <strong>
              {added.length === 1 && removed.length === 0 ? (
                <>
                  {L.confirmAddOnePre}
                  <Num>{added[0]!.display}</Num>?
                </>
              ) : (
                L.confirmTitle
              )}
            </strong>{' '}
            {added.length === 0 && removed.length === 0 ? (
              L.confirmNoChange
            ) : (
              <>
                {added.length > 1 || removed.length > 0 ? (
                  <>
                    {added.length ? (
                      <>
                        {L.confirmAdded}
                        {added.map((x, i) => (
                          <span key={x.e164}>
                            {i ? ', ' : ''}
                            <Num>{x.display}</Num>
                          </span>
                        ))}
                        .{' '}
                      </>
                    ) : null}
                    {removed.length ? (
                      <>
                        {L.confirmRemoved}
                        {removed.map((e, i) => (
                          <span key={e}>
                            {i ? ', ' : ''}
                            <Num>{displayOf(e)}</Num>
                          </span>
                        ))}
                        .{' '}
                      </>
                    ) : null}
                  </>
                ) : null}
                {L.confirmBody}
              </>
            )}
          </p>
          <button type="button" className="btn quiet" onClick={() => setPreview(null)}>
            {he.app.cancel}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={apply}
            disabled={pending || (added.length === 0 && removed.length === 0)}
          >
            {added.length === 1 && removed.length === 0 ? L.confirmApplyOne : L.confirmApply}
          </button>
        </div>
      ) : null}
      <div aria-live="polite" role="status">
        {msg ? <p className={msg.ok ? 'msg ok' : 'msg bad'}>{msg.text}</p> : null}
      </div>
      {relayTargetId ? (
        <details className="audit">
          <summary>{L.auditTitle}</summary>
          {audit === null ? (
            <p className="uses" style={{ marginTop: 8 }}>
              {L.auditUnavailable}
            </p>
          ) : audit.length === 0 ? (
            <p className="uses" style={{ marginTop: 8 }}>
              {L.auditEmpty}
            </p>
          ) : (
            <ul>
              {audit.map((e) => (
                <li key={e.id} style={{ marginTop: 6 }}>
                  <b>
                    {e.actorIsViewer
                      ? he.app.you
                      : e.actorType === 'user'
                        ? he.app.otherUser
                        : he.app.system}
                  </b>{' '}
                  · <Num>{formatDateTime(e.at)}</Num>
                  <span>
                    {L.before}
                    <NumList items={e.before} /> · {L.after}
                    <NumList items={e.after} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>
      ) : null}
    </div>
  );
}

function NumList({ items }: { items: { e164: string; display: string }[] }) {
  if (items.length === 0) return <>{L.emptyList}</>;
  return (
    <>
      {items.map((x, i) => (
        <span key={x.e164}>
          {i ? ', ' : ''}
          <Num>{x.display}</Num>
        </span>
      ))}
    </>
  );
}
