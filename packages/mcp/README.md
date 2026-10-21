# @htz/mcp

Stateless MCP server for the WhatsApp Gateway (ARCHITECTURE §6), ported from WhatsApp-Automation `src/server/mcp/`.

## Transport

- **Streamable HTTP only, stateless** (no `Mcp-Session-Id`), JSON responses. Mounted by `apps/web` at `/mcp`:
  `export const POST = (req: Request) => handleMcpRequest(req, deps, { ip })`.
  Other methods return 405.
- **stdio mode is dropped** (R3.7): it would open a second WhatsApp socket. Agents that used stdio must switch to the HTTPS URL.
- Built on `@modelcontextprotocol/sdk` (`Server` + `WebStandardStreamableHTTPServerTransport`), one server instance per request.

## Auth, rate limit, audit

- `Authorization: Bearer gw_<prefix>_<secret>`: prefix = 8 lowercase alphanumerics, secret = 32 random bytes base64url.
  `api_clients.key_hash` = lowercase hex SHA-256 of the **full token string**. Use `generateApiKey()` / `hashApiKey()` from this package so the app and MCP agree.
  Lookup by prefix, constant-time hash compare; revoked/expired keys rejected (401).
- **Legacy tokens (assumption, R3.3):** WhatsApp-Automation agent tokens are opaque strings without the `gw_` prefix, stored as SHA-256 hex of the whole token. They are imported with `key_prefix = null`, `legacy = true` and the 7 legacy scopes, and looked up with `ApiKeyRepo.findLegacyByHash`. If the legacy hash scheme differs (e.g. salted), only `hashApiKey` for legacy rows needs to change.
- Any key-lookup or rate-limiter failure fails closed (503); malformed key rows are rejected (401) (L2.3). Relay keys without `conversation_ids` are rejected (L2.2).
- Rate limits: `RateLimiter.take('req:<key id>')` per HTTP request (→ HTTP 429 + `Retry-After`), `take('send:<key id>')` per send-type tool (→ in-band `rate_limited` with `retry_after`).
- Every tool call is written to `AuditSink` with redacted args (bodies hashed, numbers masked to the last 4 digits).

## Tools

12 legacy tools with the original names (`list_automations`, `create_automation`, `update_automation`, `delete_automation`, `send_message`, `update_reply`, `get_thread`, `send_reminder`, `list_reminders`, `cancel_reminder`, `session_status`, `session_reconnect`) plus `list_accounts`, `send_media`, `send_template`, `list_templates`, `list_chats`, `get_messages`, `get_message`, `get_message_status`, `resend_message`, `mark_read`, `list_groups`, `send_group_message`, `get_capabilities`. The `tools/list` output is frozen by a snapshot test (`src/__snapshots__/tools.test.ts.snap`).

The legacy source was not available when this package was written; legacy params were reconstructed from the spec and frozen in the snapshot. Diff the snapshot against the real v1 `docs/mcp.md` before cutover.

- Without `account`, tools resolve to the alias `default` (Baileys) or `meta-default` (Cloud), whichever the key is bound to; reminder and template tools prefer `meta-default` (R3.2).
- Scopes per tool: `TOOL_SCOPES` (R3.4).
- Errors: `{ ok: false, code, message_he, message_en, action, retry_after?, detail? }`.

## Single send gate

All send-type tools (`SEND_TOOLS`) go through `throughSendGate` in `src/send-path.ts`, which calls the injected `SendGate` once before any side effect (S13 / L2.1). The app wires it to `policy.assertChatAllowed`. Chat-scoped reads call the same gate with `intent: 'read'`.

## Dependencies

Handlers depend only on the interfaces in `src/deps.ts`. In-memory fakes: `@htz/mcp/testing` (`createFakeDeps()`).
