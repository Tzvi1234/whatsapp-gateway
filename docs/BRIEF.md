# WhatsApp Gateway: Product Brief (v1.0, 2026-10-21)

## Goal
One self-hosted gateway that connects Grok Bot agents to WhatsApp through both providers (Baileys and the Meta Cloud API) behind a single interface. The first and main use: Tzvi talks to Lia on WhatsApp, and Lia is the single entry point that routes to other agents only when he asks. It replaces WhatsApp-Automation without breaking anything that already works.

## Users
1. Tzvi, as the person messaging Lia (voice, text, media) in natural WhatsApp Hebrew.
2. Tzvi, as the operator (dashboard: connect numbers, see issues and fix them).
3. Grok Bot agents (Lia first) as MCP and webhook clients.

## In scope (v1)
- Worker for Baileys on htz-home-01 (systemd --user, outbound connections only). Dashboard, MCP and the Meta webhook on Vercel. DB, queue, Vault and Storage on Supabase.
- Unified provider interface with per-provider capabilities. An unsupported feature returns an explicit error.
- MCP: 12 v1 tools stay compatible, scoped keys, rate limits, idempotent sends.
- Lia channel: 4s merge with typing indicator, signed webhook, connection test, resend of the same batch, allowlist with confirmation and an audit log, and the statuses replied, no_reply, delivery_failed and untested.
- Local Hebrew transcription (ivrit-ai turbo, CPU int8). Soniox is off.
- Heartbeat with email alerts (pg_cron + Edge Function).
- Dashboard: direction C, impeccable.style, RTL and mobile.
- Data migration from WhatsApp-Automation, with a rehearsal on a test number.

## Out of scope (v1)
Native buttons (numbered fallback instead), whatsapp-status-automator (archived), a native WhatsApp channel in Grok Bot, and paid transcription.

## Success metrics
- First number connected within 5 minutes without docs. Grok Bot connects through MCP with only a URL and a key.
- Quick acknowledgement to Tzvi (read receipt and typing) in under 2s. Time to Lia's first reply is measured, and the share of messages with no reply is tracked.
- Transcription time is tracked by recording length.
- Webhook-to-send latency, failure rate per provider, Baileys session length and reconnect time are tracked.
- 72h stability on the test number before cutover. Zero data loss in the migration (row-by-row verification).
- Every error shown in the dashboard has a clear explanation and a fix action. Silence toward strangers (default deny).

## Assumptions
Tzvi supplies dedicated numbers. Lia's inbound path is a Grok Bot routine with a webhook trigger (email as fallback). Existing Vercel and Supabase accounts are used. Volume is low (hundreds of messages per day).

## Plan
M0 spike (about 1 week): Baileys 7.x on the test number, Lia webhook and transcription quality.
M1 schema, worker, Cloud adapter and MCP. M2 dashboard. M3 Lia channel. M4 migration rehearsal. M5 cutover, only with Tzvi's approval.

Full architecture: ARCHITECTURE.md
