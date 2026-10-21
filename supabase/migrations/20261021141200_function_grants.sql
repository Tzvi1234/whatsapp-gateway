-- EXECUTE privileges, in one place. Start from zero (Supabase grants EXECUTE on new
-- functions to anon/authenticated/service_role by default), then allow per caller.
-- See docs/database.md "RPC catalogue".

revoke execute on all functions in schema public from public, anon, authenticated, service_role, gateway_worker;

-- Dashboard users: only what RLS policies evaluate.
grant execute on function
  public.is_member(uuid),
  public.is_owner(uuid),
  public.realtime_topic_allowed(text)
to authenticated;

-- Worker (custom JWT role gateway_worker).
grant execute on function
  public.claim_jobs(text, text, int),
  public.renew_lease(uuid, text),
  public.job_reserve_provider_id(uuid, text, text),
  public.complete_job(uuid, text, text),
  public.fail_job(uuid, text, boolean, text),
  public.enqueue_message(uuid, text, text, text, text, text, jsonb, text, text, uuid, text, uuid, text, timestamptz, int, text),
  public.ingest_inbound(uuid, text, text, text, text, text, boolean, text, timestamptz, boolean, text, text, text, numeric, text, jsonb, text, text),
  public.apply_message_status(uuid, text, text, timestamptz, text),
  public.message_set_transcript(uuid, text),
  public.record_heartbeat(uuid, text, text, text, jsonb),
  public.worker_try_lock_account(uuid, text, int),
  public.worker_unlock_account(uuid, text),
  public.worker_session_event(uuid, text, text, text),
  public.worker_complete_session_command(uuid, text, text),
  public.worker_pairing_qr_upsert(uuid, text, text, text, int),
  public.worker_pairing_finish(uuid, text, text, text),
  public.worker_upsert_contact(uuid, text, text, text),
  public.worker_log(uuid, text, jsonb),
  public.worker_upsert_status(uuid, text, text, text, text, timestamptz, timestamptz),
  public.worker_take_cooldown(uuid, text, text, uuid, uuid),
  public.worker_record_reply_job(uuid, text, uuid, uuid, uuid, uuid, text, text),
  public.worker_create_relay_batch(uuid, uuid[], uuid, boolean, uuid),
  public.audit_append(uuid, text, text, text, text, inet, jsonb)
to gateway_worker;

-- Server (Vercel API/MCP/webhooks and Edge Functions, service_role).
grant execute on function
  public.is_e164_array(text[]),          -- evaluated by relay_targets CHECK on direct writes
  public.claim_jobs(text, text, int),
  public.renew_lease(uuid, text),
  public.complete_job(uuid, text, text),
  public.fail_job(uuid, text, boolean, text),
  public.enqueue_message(uuid, text, text, text, text, text, jsonb, text, text, uuid, text, uuid, text, timestamptz, int, text),
  public.message_record_send_result(uuid, text, text, boolean, text),
  public.message_requeue(uuid),
  public.ingest_inbound(uuid, text, text, text, text, text, boolean, text, timestamptz, boolean, text, text, text, numeric, text, jsonb, text, text),
  public.apply_message_status(uuid, text, text, timestamptz, text),
  public.webhook_enqueue_event(uuid, uuid, text, jsonb),
  public.audit_append(uuid, text, text, text, text, inet, jsonb),
  public.audit_verify_chain(),
  public.vault_store_secret(text, text),
  public.vault_read_secret(uuid),
  public.provider_credentials_upsert(uuid, text, text, text, text, text, text, uuid, inet),
  public.provider_credentials_read(uuid),
  public.provider_credentials_mark_webhook_verified(uuid, text),
  public.create_api_client(uuid, text, text, text, text[], uuid[], uuid[], jsonb, timestamptz, boolean, uuid, inet),
  public.revoke_api_client(uuid, uuid, inet),
  public.lookup_api_client(text),
  public.api_client_touch(uuid),
  public.rate_limit_take(text, int, double precision, int),
  public.login_check_lockout(text, inet),
  public.login_record_attempt(text, inet, boolean),
  public.request_session_command(uuid, text, uuid, text, inet),
  public.create_pairing_request(uuid, uuid, text, text, inet),
  public.relay_set_target(uuid, text, text, text, int, int, boolean, uuid, inet),
  public.relay_allowlist_update(uuid, text[], uuid, boolean, inet),
  public.relay_record_test(uuid, jsonb),
  public.relay_mark_replied(uuid, timestamptz),
  public.relay_mark_delivery_failed(uuid),
  public.relay_resend_batch(uuid),
  public.relay_evaluate_no_reply(),
  public.claim_deliveries(text, int),
  public.webhook_delivery_result(uuid, int, text),
  public.relay_batch_delivery_result(uuid, int, text),
  public.heartbeat_evaluate(interval),
  public.heartbeat_claim_notifications(int),
  public.heartbeat_ack_notification(uuid, text),
  public.pairing_purge_expired(),
  public.retention_run(int, int, int, int)
to service_role;
