import { handleMcpRequest } from '@htz/mcp';
import { createMcpDeps } from '../../server/mcp-deps';
import { clientIpFrom, json } from '../../server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Stateless Streamable HTTP MCP endpoint (ARCH §6). One deps bundle per request. */
export async function POST(req: Request): Promise<Response> {
  return handleMcpRequest(req, createMcpDeps(), { ip: clientIpFrom(req.headers) });
}

function notAllowed(): Response {
  return json(
    405,
    { ok: false, code: 'invalid_input', message_en: 'Stateless MCP endpoint: use POST.' },
    { Allow: 'POST' },
  );
}

export const GET = notAllowed;
export const DELETE = notAllowed;
