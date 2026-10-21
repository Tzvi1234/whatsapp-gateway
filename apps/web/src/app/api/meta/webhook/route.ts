import { serviceClient } from '../../../../server/supabase';
import { handleMetaEvent, handleMetaVerify } from '../../../../server/meta-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Meta hub challenge (S2). */
export async function GET(req: Request): Promise<Response> {
  return handleMetaVerify(req, serviceClient());
}

/** Signed Meta events (S1): raw bytes are verified before anything is processed. */
export async function POST(req: Request): Promise<Response> {
  return handleMetaEvent(req, serviceClient());
}
