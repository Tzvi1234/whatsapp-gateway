'use client';

import Link from 'next/link';
import { Icon } from '@/ui/components/Icon';
import { he } from '@/ui/i18n/he';

/** Plain-language error with one action (R5.5). Technical detail stays out of the UI. */
export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="res bad" role="alert" style={{ marginTop: 8 }}>
      <span className="ic">
        <Icon name="alert" style={{ width: 16, height: 16 }} />
      </span>
      <strong>{he.errors.pageTitle}</strong>
      <p>{he.errors.pageBody}</p>
      <div className="acts">
        <button type="button" className="btn primary" onClick={reset}>
          <Icon name="refresh" />
          {he.errors.tryAgain}
        </button>
        <Link className="btn" href="/">
          {he.errors.goHome}
        </Link>
      </div>
    </section>
  );
}
