import type { Metadata } from 'next';
import { listApiKeys } from '@/server/actions/api-keys';
import { getEndpointUrls } from '@/server/actions/connect';
import { ApiKeys } from '@/ui/components/ApiKeys';
import { Crumbs, LoadFailed } from '@/ui/components/server-bits';
import { he } from '@/ui/i18n/he';
import { homeData } from '@/ui/server/viewer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: he.apiKeys.h1 };

export default async function ApiKeysPage() {
  const [keys, home, urls] = await Promise.all([listApiKeys(), homeData(), getEndpointUrls()]);
  return (
    <>
      <Crumbs>{he.apiKeys.h1}</Crumbs>
      <h1>{he.apiKeys.h1}</h1>
      <p className="lead">{he.apiKeys.lead}</p>
      {keys.ok ? (
        <ApiKeys
          keys={keys.data}
          accounts={
            home.ok
              ? home.data.accounts.map((a) => ({
                  id: a.id,
                  label: a.label,
                  phoneDisplay: a.phoneDisplay,
                }))
              : []
          }
          mcpUrl={urls.ok ? urls.data.mcpUrl : null}
        />
      ) : (
        <LoadFailed error={keys} retryHref="/settings/api-keys" />
      )}
    </>
  );
}
