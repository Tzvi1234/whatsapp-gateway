import type { ReactNode } from 'react';
import { ownerViewer } from '@/ui/server/viewer';

/**
 * Owner-only area (C1): connect screen, Cloud credentials, Lia setup/allowlist, API keys.
 * `assertOwnerPage()` redirects non-owners to /forbidden and AAL1 sessions to /mfa, so no QR,
 * credential field or key is ever rendered for them. Never cached (C2).
 */
export const dynamic = 'force-dynamic';

export default async function OwnerLayout({ children }: { children: ReactNode }) {
  await ownerViewer();
  return children;
}
