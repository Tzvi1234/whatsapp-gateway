import Link from 'next/link';
import { he } from '@/ui/i18n/he';

export default function NotFound() {
  return (
    <main id="main" className="auth">
      <span className="brand">{he.app.brand}</span>
      <h1>{he.errors.notFoundTitle}</h1>
      <p className="lead">{he.errors.notFoundBody}</p>
      <p style={{ marginTop: 22 }}>
        <Link className="btn primary" href="/">
          {he.errors.goHome}
        </Link>
      </p>
    </main>
  );
}
