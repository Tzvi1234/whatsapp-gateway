import { serviceClient } from '../../../../server/supabase';
import { isInternalRequest, json } from '../../../../server/http';
import { handleCloudSend } from '../../../../server/internal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Called by the `cloud-retry` Edge Function with `x-internal-secret`. */
export async function POST(req: Request): Promise<Response> {
  if (!isInternalRequest(req)) return json(401, { ok: false, code: 'unauthorized' });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, code: 'invalid_input' });
  }
  return handleCloudSend(body, serviceClient());
}
