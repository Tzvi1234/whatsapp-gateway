import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getMfaStatus } from '@/server/actions/auth';
import { LoginForm, MfaForm } from '@/ui/components/AuthForms';
import { he } from '@/ui/i18n/he';
import { safeNext } from '@/ui/lib/auth-redirect';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: he.auth.mfaTitle };

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === 'string' ? sp.next : '/');
  const s = await getMfaStatus();
  if (s.ok && !s.data.authenticated) redirect(`/login?next=${encodeURIComponent(next)}`);
  if (s.ok && s.data.aal === 'aal2') redirect(next);
  return (
    <main id="main" className="auth">
      <span className="brand">{he.app.brand}</span>
      <h1>{he.auth.mfaTitle}</h1>
      {s.ok ? (
        <MfaForm mode={s.data.verifiedFactorIds.length > 0 ? 'verify' : 'enroll'} next={next} />
      ) : (
        <>
          <p className="lead" role="alert">
            {s.message_he}
          </p>
          <LoginForm next={next} turnstile={false} />
        </>
      )}
    </main>
  );
}
