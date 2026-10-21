import type { Metadata } from 'next';
import { getEndpointUrls } from '@/server/actions/connect';
import { getAccountDetail, type AccountDetail } from '@/server/actions/read-models';
import { ConnectFlow, type ConnectAccount, type Method } from '@/ui/components/ConnectFlow';
import { Crumbs, LoadFailed } from '@/ui/components/server-bits';
import { he } from '@/ui/i18n/he';

/** C2: the QR is rendered only for owner + AAL2 (owner layout) and never cached. */
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const metadata: Metadata = { title: he.connect.crumbs };

const METHODS: Method[] = ['qr', 'pairing', 'cloud'];

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const accountParam = typeof sp.account === 'string' ? sp.account : null;
  const methodParam = typeof sp.method === 'string' ? sp.method : 'qr';
  let method: Method = (METHODS as string[]).includes(methodParam) ? (methodParam as Method) : 'qr';

  const [urls, detail] = await Promise.all([
    getEndpointUrls(),
    accountParam ? getAccountDetail(accountParam) : Promise.resolve(null),
  ]);
  if (detail && !detail.ok) {
    return (
      <>
        <Crumbs>{he.connect.crumbs}</Crumbs>
        <h1>{he.connect.h1}</h1>
        <LoadFailed error={detail} retryHref="/connect" />
      </>
    );
  }
  const d: AccountDetail | null = detail?.ok ? detail.data : null;
  const account: ConnectAccount | null = d
    ? {
        id: d.account.id,
        provider: d.account.provider,
        label: d.account.label,
        phoneDisplay: d.account.phoneDisplay,
      }
    : null;
  if (account?.provider === 'meta_cloud') method = 'cloud';
  if (account?.provider === 'baileys' && method === 'cloud') method = 'qr';

  return (
    <>
      <Crumbs>{he.connect.crumbs}</Crumbs>
      <h1>{account ? account.label : he.connect.h1}</h1>
      <p className="lead">{he.connect.lead}</p>
      <ConnectFlow
        account={account}
        initialMethod={method}
        webhookUrl={urls.ok ? urls.data.metaWebhookUrl : (d?.webhookUrl ?? null)}
        credentials={d?.credentials ?? null}
        webhookUrlChanged={d?.webhookUrlChanged ?? false}
      />
    </>
  );
}
