# Lia connection test: status contract (canonical)

Owner: Code Designer. Dashboard, API and QA use exactly these values.

```ts
// Canonical list = ARCHITECTURE.md (Software Architect). This file mirrors it.
type LiaTestStatus =
  | "accepted"        // webhook 2xx; after 2 min with no reply stays "accepted" + waiting: true
  | "replied"         // Lia replied with reply_to_id = test message
  | "rejected_key"    // webhook 401/403
  | "unreachable"     // network error, timeout or 5xx
  | "no_reply"        // no reply after alert threshold (default 10 min; 5/10/30)
  | "delivery_failed";// Lia replied but delivery to Tzvi failed (e.g. Baileys disconnected)

interface LiaTestResult {
  status: LiaTestStatus;
  waiting?: boolean;       // only with "accepted"
  reason: string;          // stable English code; Hebrew copy lives in the dashboard
  elapsed_ms: number;
  received_ms?: number;    // with "replied"
  reply_ms?: number;       // with "replied"
}
```

Behaviour
- The UI's "waiting" phase covers the first 2 minutes; status stays `accepted` (waiting: true) until reply or threshold.
- There is no failure at 2 minutes. `no_reply` only after the alert threshold.
- Test payload carries `is_test: true`. Resend reuses the same `batch_id` and `message_id`s.
- Exact webhook behaviour for a wrong key is verified in the spike before lock.

Outbound URL guard (SSRF), module `packages/policy/outbound-url-guard`
- https only, and only the Grok Bot webhooks domain on the allowlist; resolve DNS and block loopback, link-local (169.254/16, fe80::/10), private ranges (10/8, 172.16/12, 192.168/16, fc00::/7), CGNAT/Tailscale 100.64/10.
- Redirects are not followed. Pin the connection to the exact IP that was checked (original hostname in SNI and Host header), never re-resolve (DNS rebinding). Cap response time and body size.
- Applies to the Lia webhook URL and any other user-supplied outbound URL.

Channel state "untested"
- Not part of LiaTestStatus. Channel object exposes `last_verified_at: string | null` (set only when a test reaches `replied`) and `last_test: LiaTestResult | null` (details of the latest test).
- `last_verified_at === null` renders as "לא נבדק". `accepted` does not set it.
- Any change to the webhook URL or sender key resets `last_verified_at` to null.

## Relay payload (batch envelope)
Top-level: `batch_id: string` (stable across retries and "resend"; also sent as `Idempotency-Key` header), `is_test: boolean`, `messages: RelayMessage[]`.
`RelayMessage`: `message_id`, `from`, `timestamp`, `type`, `text`, `media_url`, `transcript` (string | null), `reply_to_id`, `is_forwarded`.
Follow-up transcript event reuses the original `message_id` and references its `batch_id`.
