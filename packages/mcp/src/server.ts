import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { gatewayError, type GatewayError } from '@htz/core';
import { authenticate, type AuthContext } from './auth';
import type { McpDeps } from './deps';
import { toolError } from './errors';
import { createToolRuntime } from './runtime';
import { toolDescriptors } from './tools';

export const MCP_SERVER_NAME = 'whatsapp-gateway';
export const MCP_SERVER_VERSION = '1.0.0';
/** Request bodies above this are rejected by the transport (413). */
const MAX_BODY_BYTES = 256 * 1024;

export interface HandleMcpOptions {
  /** Client IP for the audit log (from the platform's trusted header). */
  ip?: string | null;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function httpError(
  status: number,
  e: GatewayError,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, toolError(e), headers);
}

async function auditAuthFailure(deps: McpDeps, e: GatewayError, ip: string | null): Promise<void> {
  try {
    await deps.audit.record({
      actorType: 'api_client',
      actorId: null,
      action: 'mcp.auth',
      target: null,
      outcome: e.code === 'internal' ? 'error' : 'rejected',
      code: e.code,
      meta: e.detail ? { detail: e.detail } : {},
      ip,
      requestId: randomUUID(),
      at: (deps.now ?? (() => new Date()))().toISOString(),
    });
  } catch {
    // ignore: auth already failed closed
  }
}

/** Builds a fresh low-level MCP server bound to one authenticated request. */
function buildServer(deps: McpDeps, auth: AuthContext, ip: string | null): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  const runtime = createToolRuntime(deps, auth, { ip });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDescriptors() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const out = await runtime.callTool(req.params.name, req.params.arguments ?? {});
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(out.payload) }],
      structuredContent: out.payload,
      isError: out.isError,
    };
  });
  return server;
}

/**
 * Stateless Streamable HTTP MCP endpoint (Next.js route handler friendly):
 * `export const POST = (req: Request) => handleMcpRequest(req, deps)`.
 * Auth (Bearer key) and the per-key request rate limit run BEFORE the MCP layer.
 * stdio is intentionally not supported (R3.7).
 */
export async function handleMcpRequest(
  req: Request,
  deps: McpDeps,
  opts: HandleMcpOptions = {},
): Promise<Response> {
  const ip = opts.ip ?? null;
  if (req.method !== 'POST') {
    return jsonResponse(
      405,
      { ok: false, code: 'invalid_input', message_en: 'Stateless MCP endpoint: use POST.' },
      { Allow: 'POST' },
    );
  }

  const now = (deps.now ?? (() => new Date()))();
  const auth = await authenticate(deps.apiKeys, req.headers.get('authorization'), now);
  if (!auth.ok) {
    await auditAuthFailure(deps, auth.error, ip);
    return auth.error.code === 'internal'
      ? httpError(503, auth.error)
      : httpError(401, auth.error, { 'WWW-Authenticate': 'Bearer realm="mcp"' });
  }

  let decision;
  try {
    decision = await deps.rateLimiter.take(`req:${auth.value.apiClientId}`);
  } catch {
    return httpError(503, gatewayError('internal', 'rate_limiter_failed', { transient: true }));
  }
  if (!decision.allowed) {
    const e = gatewayError('rate_limited', 'request_rate', { retryAfterMs: decision.retryAfterMs });
    const secs = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    return httpError(429, e, { 'Retry-After': String(secs) });
  }
  void deps.apiKeys.touchLastUsed?.(auth.value.apiClientId)?.catch(() => undefined);

  // We always answer with JSON; accept clients that only advertise application/json.
  const headers = new Headers(req.headers);
  headers.set('accept', 'application/json, text/event-stream');
  if (!headers.get('content-type')) headers.set('content-type', 'application/json');
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return httpError(413, gatewayError('invalid_input', 'body_too_large'));
  }
  const normalized = new Request(req.url, { method: 'POST', headers, body });

  const server = buildServer(deps, auth.value, ip);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // no sessionIdGenerator => stateless mode (no Mcp-Session-Id), safe on serverless
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(normalized);
    const out = new Headers(res.headers);
    out.set('Cache-Control', 'no-store');
    return new Response(await res.text(), { status: res.status, headers: out });
  } finally {
    await server.close().catch(() => undefined);
  }
}
