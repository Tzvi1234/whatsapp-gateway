'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { logout } from '@/server/actions/auth';
import { he } from '../i18n/he';
import { Icon } from './Icon';

export interface Destination {
  label: string;
  href: string;
  hint?: string;
}

/**
 * The mockups' top bar: brand, the "חיפוש מספר, הודעה או פעולה" command field (Ctrl K jumps
 * to numbers and pages) and the avatar, which opens the account menu.
 */
export function AppBar({
  destinations,
  email,
  isOwner,
}: {
  destinations: Destination[];
  email: string | null;
  isOwner: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const listId = useId();
  const [loggingOut, startLogout] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    const digits = t.replace(/\D/g, '');
    if (!t) return destinations.slice(0, 8);
    return destinations
      .filter((d) => {
        const hay = `${d.label} ${d.hint ?? ''}`.toLowerCase();
        if (hay.includes(t)) return true;
        return (
          digits.length >= 3 && (d.hint ?? '').replace(/\D/g, '').includes(digits.replace(/^0/, ''))
        );
      })
      .slice(0, 8);
  }, [q, destinations]);

  const go = (href: string) => {
    setOpen(false);
    setQ('');
    router.push(href);
  };

  const initials = (email ?? '?').split('@')[0]!.slice(0, 2).toUpperCase();

  return (
    <div className="bar">
      <Link href="/" className="brand" style={{ textDecoration: 'none' }}>
        {he.app.brand}
      </Link>
      <div className="cmd" role="search">
        <Icon name="list" />
        <label htmlFor={`${listId}-q`} className="sr-only">
          {he.app.searchLabel}
        </label>
        <input
          id={`${listId}-q`}
          ref={inputRef}
          type="search"
          placeholder={he.app.searchPlaceholder}
          value={q}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              const d = results[sel];
              if (d) {
                e.preventDefault();
                go(d.href);
              }
            } else if (e.key === 'Escape') {
              setOpen(false);
              inputRef.current?.blur();
            }
          }}
        />
        <kbd>Ctrl K</kbd>
        {open ? (
          <ul className="results" id={listId} role="listbox">
            {results.length === 0 ? (
              <li
                role="option"
                aria-selected="false"
                aria-disabled="true"
                style={{ padding: 10, color: 'var(--muted)' }}
              >
                {he.app.searchEmpty}
              </li>
            ) : (
              results.map((d, i) => (
                <li key={d.href} role="option" aria-selected={i === sel}>
                  <Link href={d.href} onClick={() => setOpen(false)} tabIndex={-1}>
                    {d.label}
                    {d.hint ? (
                      <small>
                        <bdi className="num">{d.hint}</bdi>
                      </small>
                    ) : null}
                  </Link>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
      <details className="menu">
        <summary aria-label={he.app.menuLabel}>
          <span className="avatar" aria-hidden="true">
            {initials}
          </span>
        </summary>
        <div className="panel">
          {email ? (
            <div className="who">
              <bdi>{email}</bdi>
            </div>
          ) : null}
          <Link href="/">{he.app.home}</Link>
          <Link href="/health">
            <Icon name="pulse" />
            {he.app.health}
          </Link>
          {isOwner ? (
            <>
              <Link href="/connect">
                <Icon name="plus" />
                {he.app.connect}
              </Link>
              <Link href="/settings/api-keys">
                <Icon name="key" />
                {he.app.apiKeys}
              </Link>
            </>
          ) : null}
          <button
            type="button"
            disabled={loggingOut}
            onClick={() =>
              startLogout(async () => {
                await logout();
                router.replace('/login');
                router.refresh();
              })
            }
          >
            <Icon name="x" />
            {loggingOut ? he.app.loggingOut : he.app.logout}
          </button>
        </div>
      </details>
    </div>
  );
}
