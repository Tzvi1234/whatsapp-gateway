# WhatsApp Gateway: Code Structure & Conventions (v0.1, Code Designer)

Source of truth for layout, module boundaries and conventions. Derived from ARCHITECTURE.md v1.0 (§3, §7.6, §9.1, §9.3). Status contract: contracts/lia-connection-test.md.

## 1. Repo layout (pnpm workspaces + Turborepo)

```
whatsapp-gateway/
  apps/
    web/                    # Next.js (App Router) on Vercel: dashboard, /api/*, /mcp, /api/meta/webhook, deliverer
      src/app/              # routes only; no business logic here
      src/server/           # server-only adapters (supabase client, vault, auth guards)
      src/ui/               # components, i18n (he default, RTL)
    worker/                 # htz-home-01, systemd --user, outbound only
      src/session/          # BaileysSession, auth store (AES-GCM), key store
      src/queue/            # Realtime subscribe + polling fallback, ack/nack
      src/inbound/          # normalize -> sender-guard -> debouncer -> transcriber -> relay enqueue
      src/heartbeat/
      src/main.ts           # composition root only
  packages/
    core/                   # types, WhatsAppProvider, Capabilities, GatewayErrorCode, normalizeJid, Result
    providers/
      baileys/              # BaileysProvider (worker only)
      cloud/                # CloudApiProvider (Vercel), signature verify
    policy/                 # assertChatAllowed, may_initiate, use-case guard, sender allowlist, outbound-url-guard
    relay/                  # agent-relay payload, batching (4s debounce, 30s transcript cap), is_test, resend, statuses
    mcp/                    # tool defs v1 (12, frozen) + extensions; handlers depend on interfaces only
    automations/            # ported matcher/policy/reply/status/time/jid + their tests
    config/                 # shared tsconfig, eslint, vitest presets
  supabase/
    migrations/  tests/     # pgTAP (RLS, append-only audit)
  .github/workflows/ci.yml
  docs/                     # ARCHITECTURE.md, BRIEF.md, CODE-STRUCTURE.md, adr/
```

## 2. Dependency rules (enforced by eslint boundaries)
- `core` depends on nothing internal. Everything may depend on `core`.
- `policy`, `relay`, `automations` depend only on `core`.
- `providers/*` depend on `core` (+ their SDK). `providers/baileys` may be imported only by `apps/worker`.
- `mcp` depends on `core`, `policy`; never on a concrete provider. It receives a `ProviderRouter`.
- `apps/*` are composition roots. No package imports from `apps/*`.
- Every outbound send to a chat passes `policy.assertChatAllowed()` exactly once, in the shared send path (not per tool). Fail closed.
- Every user-supplied outbound URL passes `policy.outboundUrlGuard` (https only, allowlisted domain, IP pinned, no redirects, size/time caps).

## 3. Conventions
- TypeScript strict, ESM, Node 22. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Errors: return `Result<T, GatewayError>` across package boundaries; throw only for programmer bugs. Error codes are a closed union in `core/errors.ts`.
- Validation at every edge (HTTP, MCP, webhook, DB rows) with zod; types inferred from schemas.
- Names: files kebab-case, types PascalCase, enums as string-literal unions (no TS `enum`). DB snake_case; map at the repository layer.
- No secrets in code, logs or test fixtures. Logger (pino) redacts tokens, keys, phone numbers by default.
- Time: store timestamptz UTC; display Asia/Jerusalem in UI only.
- Tests: vitest, colocated `*.test.ts`. Ported WA-Automation tests must stay green unchanged. Security paths (allowlist, scopes, SSRF, signatures) require negative tests.
- Commits: Conventional Commits. One concern per PR, <= ~400 changed lines where possible.

## 4. CI (task 0.1), all required to pass
1. `pnpm install --frozen-lockfile`
2. typecheck (`tsc -b`), lint (eslint + boundaries), format check (prettier)
3. unit tests (vitest) with coverage report
4. gitleaks (secret scan, full history on PR)
5. dependency audit (`pnpm audit --prod --audit-level=high`)
6. Baileys pin check: `baileys` must be an exact version (no ^/~), equal to the value in `docs/adr` / a single `BAILEYS_VERSION` constant; currently `7.0.0-rc14` (fallback 6.7.24 per ADR)
7. (later, 1.1) `supabase test db` pgTAP + migration dry-run, against local Supabase (`supabase start`), no cloud project needed
8. main-push guard: separate workflow on `push` to `main`; fails and emails Tzvi if the head commit is not the merge of an approved PR (GitHub Free cannot protect main on a private repo). Branch names allowed: `feat/*`, `fix/*`, `spike/*`, `docs/*`.
9. Test IDs: test titles start with the TEST-PLAN.md ID (e.g. `it("L2.1 rejects ...")`) so QA can report pass/fail per ID from CI output.
Node 22, pnpm via corepack, Turborepo cache. No deploy steps in CI. Worker deploy stays manual.

## 5. PR review checklist (Code Designer, before QA)
- Matches layout + dependency rules; no provider branching outside providers/router.
- Every send path goes through assertChatAllowed; every outbound URL through outboundUrlGuard.
- MCP v1 tool names/params/returns unchanged (snapshot test).
- Inputs validated; errors typed; no secrets/PII in logs.
- Tests cover happy path + at least one negative/security case.
- Status/enum values exactly as in contracts/*.md and ARCHITECTURE.md.

## 6. Task 0.1 breakdown
- 0.1a Root: pnpm-workspace, turbo.json, tsconfig base, eslint (+ import boundaries), prettier, .editorconfig, .nvmrc (22), .gitignore, gitleaks config.
- 0.1b Empty packages/apps with package.json, tsconfig, index.ts and one smoke test each.
- 0.1c `packages/core`: skeleton types from ARCHITECTURE §3 (no logic).
- 0.1d CI workflow with steps 1-6, Baileys pin script.
- 0.1e README with dev setup.
Done when: CI green on the PR, no runtime logic beyond types and smoke tests.

## 7. M0 additions (connect screen + Baileys spike)
- Spike code lives in `spikes/baileys7/` (own package.json; may depend on `@htz/core` and `@htz/provider-baileys` via `workspace:*`, but nothing imports the spike).
- Store interfaces (so the spike tests the production config): `packages/providers/baileys/src/store/types.ts` defines `SessionStore` (creds + signal keys wrapped by `makeCacheableSignalKeyStore`, plus sent-message lookup backing `getMessage`). Implementations: `sqlite-store.ts` (spike, local) and later `supabase-store.ts` (M1). Both must pass the same contract test suite `store.contract.test.ts`. `useMultiFileAuthState` is banned (lint rule).
- Pairing: pairing code only; the code is never printed to stdout/journal/JSONL. Branch `spike/baileys7`. Local logs: `~/baileys-spike/` (JSONL/SQLite), auth in `~/baileys-spike/auth`.
- Phone normalization: `packages/core/phone.ts` exports `toE164(input, defaultRegion='IL')` (05x -> +9725x) used by UI, API and `normalizeJid`. One implementation only.
- Cloud API credentials check: `packages/providers/cloud/verify-credentials.ts` (server-only; calls Graph with Phone Number ID + WABA ID + token). Secrets go straight to Vault through `apps/web/src/server/vault.ts`; API returns only `last4`.
- Connect screen: `apps/web/src/app/(owner)/connect/` with tabs `qr` | `pairing` | `cloud`. Route group `(owner)` enforces owner + AAL2 in layout and middleware; QR/pairing code fetched via server action, never cached.
- Encryption at rest: one module `packages/providers/baileys/src/store/crypto.ts` (AES-256-GCM, random 12-byte nonce per record, AAD = `account_id|record_type|record_id`, key version prefix for rotation). Used by both `sqlite-store` and `supabase-store`; stores never call `crypto` APIs directly. Contract tests: wrong key fails, wrong AAD (row copied to another account) fails (TEST-PLAN S4).
- Env config: `apps/web/src/server/env.ts` parses `process.env` once with zod at boot (fail fast). `PUBLIC_BASE_URL` required, https only, no trailing slash. No other file reads `process.env`. Webhook URL comes only from `metaWebhookUrl()` in `apps/web/src/server/urls.ts`; the stored `verified_webhook_url` is compared to it to show the "address changed, update in Meta" banner.
- Personal numbers (allowlist seed, blocked numbers) come from config/env only, never from code, tests, fixtures or docs.
