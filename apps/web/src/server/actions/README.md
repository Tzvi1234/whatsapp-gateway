# Server actions catalogue (for the dashboard UI)

All actions live in `src/server/actions/*.ts` (`'use server'` modules). Import them from client or
server components. Every action returns:

```ts
type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message_he: string; retryAfterSeconds?: number; fields?: Record<string, string> };
```

- Show `message_he` as-is (plain Hebrew, already actionable). Show `code` only under "מה לבדוק".
- `fields` maps a form field path (e.g. `phone`, `senders.2`) to a short Hebrew hint.
- Auth failures come back as codes `unauthenticated` → go to `/login`, `mfa_required` → `/mfa`,
  `not_owner` / `not_member` → `/forbidden` (the UI owns that page).
- Owner-only actions require owner + AAL2 (C1). Read models need any member at AAL2 (R5.2).
- Nothing returns secrets: credentials and keys come back as last 4 chars only (C5, L5.6). The
  only plaintext that is ever returned is (a) a new API key from `createApiKey` (show once, then
  discard from state) and (b) the user's own TOTP enrolment secret from `mfaEnroll`.

Page guards for server components: `assertOwnerPage()` / `assertMemberPage()` from
`src/server/auth.ts` (redirect to `/login`, `/mfa` or `/forbidden`). Use `assertOwnerPage()` in
`app/(owner)/layout.tsx`. The proxy (`src/proxy.ts`) already redirects logged-out → `/login` and
AAL1 → `/mfa?next=…` for every non-machine route; `/login`, `/mfa`, `/forbidden` must be built by
the UI. For Realtime in client components get `{ url, anonKey }` from `publicSupabaseConfig()`
(server-only, pass as props).

## `actions/auth.ts`

| Action | Returns | UI |
|---|---|---|
| `login({ email, password, turnstileToken? })` | `{ next: 'mfa_enroll' \| 'mfa_verify' }` | Lockout (R5.1): `code: 'locked'` + `retryAfterSeconds` → show countdown. `captcha_failed` when Turnstile is configured. Then route to `/mfa`. |
| `logout()` | `null` | Redirect to `/login`. |
| `getMfaStatus()` | `{ authenticated, aal: 'aal1'\|'aal2'\|null, verifiedFactorIds }` | Decide enrol vs verify on `/mfa`. |
| `mfaEnroll()` | `{ factorId, qrCodeSvg, secret, uri }` | Render `qrCodeSvg` (Supabase returns an SVG data URL; use as `<img src>`), show `secret` for manual entry, then call `mfaVerify({ factorId, code })`. |
| `mfaVerify({ factorId?, code })` | `{ aal: 'aal2' }` | 6 digits. On success `router.replace(next ?? '/')`. |

## `actions/connect.ts` (owner)

| Action | Returns | UI |
|---|---|---|
| `createAccount({ provider: 'baileys'\|'meta_cloud', label, alias?, isTest?, useCases? })` | `{ accountId }` | Then pairing (Baileys) or the Cloud form. `duplicate` → alias/number exists. |
| `startPairing({ accountId, method: 'qr'\|'code', phone? })` | `{ requestId, method, phoneE164, phoneDisplay, expiresInSeconds }` | For `code`, show the number corrected (`phoneDisplay`, C7) not as an error. Then poll `getPairingState`. |
| `getPairingState(requestId)` | `{ state, qrSvg, pairingCode, qrExpiresAt, requestExpiresAt }` | Poll every ~2 s (or subscribe to private Realtime topic `org:<org_id>:pairing` and re-fetch). Render `qrSvg` inline (SVG markup string). `state: 'paired'` → success + "Send a test message" CTA. Never cache or log. |
| `saveCloudCredentials({ accountId, phoneNumberId, wabaId, accessToken, appSecret, verifyToken })` | `{ phoneNumberId, wabaId, displayPhoneNumber, verifiedName, tokenLast4, appSecretLast4, verifyTokenLast4, webhookUrl }` | Verified with Graph first; failure codes `invalid_token`, `permission_denied`, `phone_number_not_found`, `waba_not_found`, `phone_not_in_waba`, `graph_unavailable`, `invalid_input` with Hebrew text (C4). Nothing saved on failure. Clear secret inputs after success; show masked `••••1234`. Show `webhookUrl` with a copy button (C6). |
| `getEndpointUrls()` | `{ metaWebhookUrl, mcpUrl }` | Copy buttons. |
| `reconnect(accountId)` | `{ commandId }` | One-click Reconnect. |
| `resendMessage(messageId)` | `{ messageId, jobId }` | Resend for failed/cancelled outbound. Policy errors (`use_case_not_allowed`, `outside_24h_window`…) come back as normal failures. |
| `sendTestMessage({ accountId, to, text })` | `{ messageId, status, errorCode }` | "Send a test message" CTA. Goes through the same policy gate as MCP. |

## `actions/relay.ts` (owner, Lia channel)

| Action | Returns | UI |
|---|---|---|
| `saveRelayTarget({ accountId, name?='Lia', url, secret?, debounceMs?, noReplyThresholdMin?: 5\|10\|30, enabled? })` | `RelayTargetView` | `url_not_allowed` (SSRF guard, S3) / `secret_required` for a new channel. Secret is write-only: leave empty to keep. Any URL/key change resets the channel to "לא נבדק" (L5.5). If `metaPolicyWarning` show the agreed Meta-policy warning (L5.7), not blocking. |
| `updateAllowlist({ relayTargetId, senders, confirmed })` | `{ applied, before, after: {e164, display}[] }` | Two steps (L6.1): call with `confirmed:false` to preview the normalised list, show a confirmation dialog (before → after), then `confirmed:true`. |
| `sendLiaTest(relayTargetId)` | `{ batchId, status, lastTest, channel }` | Sends `is_test: true` (L5.1). `status` is the canonical enum or `null` (retrying). After `accepted`, poll `getLiaChannel` — `lastTest.waiting` for the first 2 min; `replied` sets the channel to verified. |
| `resendRelayBatch(batchId)` | `{ batchId }` | "Resend to Lia" (same batch id, L4.8). `conflict` if Lia already replied. |

`RelayTargetView`: `{ id, accountId, name, urlMasked, secretLast4, enabled, debounceMs, noReplyThresholdMin, allowlist: {e164, display}[], channel: 'untested'|'verified', lastVerifiedAt, lastTest: LiaTestResult|null, metaPolicyWarning }`.
`channel === 'untested'` renders "לא נבדק". Never render raw enum chips in the main UI (L5.8).

## `actions/api-keys.ts` (owner)

| Action | Returns | UI |
|---|---|---|
| `createApiKey({ name, scopes, accountIds, conversationIds?, expiresAt?, requestsPerMin?, sendsPerMin?, password })` | `{ id, name, prefix, token, mcpUrl }` | Re-auth (R5.6): ask for the password in the dialog. `reauth_failed` / `locked`. `relay` scope requires `conversationIds` (L2.2). Show `token` ONCE with copy + "I saved it", then drop it from state. |
| `revokeApiKey(id)` | `{ revoked }` | Confirm dialog. |
| `listApiKeys()` | `ApiKeyView[]` | `{ id, name, prefix, scopes, accountIds, conversationIds, legacy, createdAt, expiresAt, revokedAt, lastUsedAt }`. Flag `legacy` keys "legacy, rotate". |

## `actions/media.ts`

| Action | Auth | Returns |
|---|---|---|
| `getVoiceOriginalUrl(messageId)` | member | `{ url, expiresInSeconds, mime }` — "play original" for a voice note (any stored media). Signed URL valid ≤15 min (S9): fetch it right before playing, never cache. `media_purged` after the 30-day retention ("ההקלטה המקורית כבר לא שמורה"), `media_unavailable` while Cloud media is not copied yet, `not_found`. |

## `actions/read-models.ts`

| Action | Auth | Returns |
|---|---|---|
| `getHomeData()` | member | `{ accounts: AccountCard[], openAlerts: AlertView[], worker: {workerId, version, baileysVersion, at} \| null, failedRate: {provider, window, total, failed, rate}[] }` |
| `getAccountDetail(accountId)` | member (credentials only visible to owner via RLS) | `{ account: AccountCard, credentials: {phoneNumberId, wabaId, tokenLast4, appSecretLast4, verifyTokenLast4, lastVerifiedAt, verifiedWebhookUrl, webhookVerifiedAt} \| null, webhookUrl, webhookUrlChanged, sessionEvents, failedMessages }` — show the C15 banner "הכתובת השתנתה, עדכן ב-Meta" when `webhookUrlChanged`. |
| `getLiaChannel(accountId)` | owner | `{ target: RelayTargetView \| null, batches: {batchId, status, isTest, attempts, createdAt, acceptedAt, repliedAt}[] }` |
| `getHealthMetrics()` | member | One array of rows per view: `failedRateByProvider`, `sessionLifetime`, `reconnectTime`, `sendLatency`, `relayFirstResponse`, `relayNoReplyRate`, `transcriptLatency`, `firstConnectFunnel` (columns as in `docs/database.md` §8, without `org_id`). |

`AccountCard`: `{ id, label, provider, alias, phoneE164, phoneDisplay, status, connection, lastHeartbeatAt, lastErrorCode, allowedUseCases, relay, isTest, capabilities }` — show the provider badge and allowed use cases (ARCH §7.6). Display times in Asia/Jerusalem.
