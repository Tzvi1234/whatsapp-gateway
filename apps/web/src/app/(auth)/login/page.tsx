import type { Metadata } from 'next';
import { env } from '@/server/env';
import { LoginForm } from '@/ui/components/AuthForms';
import { he } from '@/ui/i18n/he';
import { safeNext } from '@/ui/lib/auth-redirect';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: he.auth.loginTitle };

function turnstileConfigured(): boolean {
  try {
    return env().TURNSTILE_SECRET !== null;
  } catch {
    return false;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = safeNext(typeof sp.next === 'string' ? sp.next : '/');
  return (
    <main id="main" className="auth">
      <span className="brand">{he.app.brand}</span>
      <h1>{he.auth.loginTitle}</h1>
      <p className="lead">{he.auth.loginLead}</p>
      <LoginForm next={next} turnstile={turnstileConfigured()} />
    </main>
  );
}
