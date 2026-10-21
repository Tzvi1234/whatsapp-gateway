import type { Metadata } from 'next';
import Link from 'next/link';
import { Icon } from '@/ui/components/Icon';
import { LogoutButton } from '@/ui/components/client';
import { he } from '@/ui/i18n/he';

export const metadata: Metadata = { title: he.auth.forbiddenTitle };

export default function ForbiddenPage() {
  return (
    <main id="main" className="auth">
      <span className="brand">{he.app.brand}</span>
      <div className="gate">
        <Icon name="info" />
        <div>
          <h1 style={{ fontSize: 22 }}>{he.auth.forbiddenTitle}</h1>
          <p>{he.auth.forbiddenBody}</p>
          <div className="row-acts" style={{ marginTop: 14 }}>
            <Link className="btn primary" href="/">
              {he.errors.goHome}
            </Link>
            <LogoutButton label={he.auth.switchUser} />
          </div>
        </div>
      </div>
    </main>
  );
}
