import type { ReactNode } from 'react';
import { AppBar, type Destination } from '@/ui/components/AppBar';
import { he } from '@/ui/i18n/he';
import { homeData, memberViewer } from '@/ui/server/viewer';

/** Dashboard shell: any org member at AAL2 (R5.2). Never prerendered or cached. */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await memberViewer();
  const home = await homeData();
  const isOwner = viewer.role === 'owner';
  const destinations: Destination[] = [
    { label: he.app.home, href: '/' },
    ...(home.ok
      ? home.data.accounts.map((a) => ({
          label: a.label,
          href: `/numbers/${a.id}`,
          ...(a.phoneDisplay ? { hint: a.phoneDisplay } : {}),
        }))
      : []),
    ...(isOwner && home.ok
      ? home.data.accounts
          .filter((a) => a.relay)
          .map((a) => ({ label: `${he.lia.crumbs} · ${a.label}`, href: `/numbers/${a.id}/lia` }))
      : []),
    ...(isOwner ? [{ label: he.app.connect, href: '/connect' }] : []),
    { label: he.app.health, href: '/health' },
    ...(isOwner ? [{ label: he.app.apiKeys, href: '/settings/api-keys' }] : []),
  ];
  return (
    <div className="shell">
      <AppBar destinations={destinations} email={viewer.email} isOwner={isOwner} />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
