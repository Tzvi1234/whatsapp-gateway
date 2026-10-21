import { randomUUID } from 'node:crypto';
import {
  err,
  gatewayError,
  LEGACY_ACCOUNT_ALIASES,
  ok,
  type GatewayError,
  type Result,
} from '@htz/core';
import type { AuthContext } from './auth';
import type { ToolContext, ToolPayload } from './context';
import type { AccountRef, AuditEntry, McpDeps } from './deps';
import { toolError, type ToolErrorPayload } from './errors';
import { HANDLERS } from './handlers';
import { redactArgs } from './redact';
import { CLOUD_FIRST_TOOLS, SEND_TOOLS, TOOL_SCHEMAS, TOOL_SCOPES, type ToolName } from './tools';

export interface CallOutcome {
  isError: boolean;
  payload: ToolPayload | ToolErrorPayload;
}

export interface RuntimeOptions {
  ip?: string | null;
  requestId?: string;
}

const SEND_TOOL_SET: ReadonlySet<string> = new Set(SEND_TOOLS);

function isToolName(n: string): n is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, n);
}

/** R3.2: without `account`, resolve the migration alias the key is bound to. */
async function resolveAccount(
  deps: McpDeps,
  auth: AuthContext,
  tool: ToolName,
  ref: string | undefined,
): Promise<Result<AccountRef>> {
  const bound = new Set(auth.accountIds);
  if (ref !== undefined) {
    const r = await deps.accounts.resolve(ref);
    if (!r.ok) return r;
    if (!r.value) return err(gatewayError('not_found', 'account_not_found'));
    if (!bound.has(r.value.id)) return err(gatewayError('forbidden_account', 'account_not_bound'));
    return ok(r.value);
  }
  const aliases = CLOUD_FIRST_TOOLS.has(tool)
    ? [LEGACY_ACCOUNT_ALIASES.meta_cloud, LEGACY_ACCOUNT_ALIASES.baileys]
    : [LEGACY_ACCOUNT_ALIASES.baileys, LEGACY_ACCOUNT_ALIASES.meta_cloud];
  let sawUnbound = false;
  for (const alias of aliases) {
    const r = await deps.accounts.resolve(alias);
    if (!r.ok) return r;
    if (!r.value) continue;
    if (bound.has(r.value.id)) return ok(r.value);
    sawUnbound = true;
  }
  if (auth.accountIds.length === 1) {
    const r = await deps.accounts.resolve(auth.accountIds[0]!);
    if (!r.ok) return r;
    if (r.value && r.value.id === auth.accountIds[0]) return ok(r.value);
  }
  return err(
    sawUnbound
      ? gatewayError('forbidden_account', 'default_alias_not_bound')
      : gatewayError('not_found', 'no_default_account'),
  );
}

function firstIssue(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  const i = issues[0];
  if (!i) return 'invalid_arguments';
  const path = i.path.map(String).join('.');
  return path ? `invalid_${path}` : 'invalid_arguments';
}

/**
 * Per-request tool runtime: scope check → zod validation → account resolution/binding →
 * handler → audit. Every failure returns the §6 error shape; thrown errors fail closed.
 */
export function createToolRuntime(deps: McpDeps, auth: AuthContext, opts: RuntimeOptions = {}) {
  const now = deps.now ?? (() => new Date());
  const randomId = deps.randomId ?? (() => randomUUID());
  const requestId = opts.requestId ?? randomId();

  async function audit(
    tool: string,
    target: string | null,
    outcome: AuditEntry['outcome'],
    error: GatewayError | null,
    meta: Record<string, unknown>,
  ): Promise<void> {
    try {
      await deps.audit.record({
        actorType: 'api_client',
        actorId: auth.apiClientId,
        action: `mcp.${tool}`,
        target,
        outcome,
        code: error?.code ?? null,
        meta,
        ip: opts.ip ?? null,
        requestId,
        at: now().toISOString(),
      });
    } catch {
      // Audit failures must not turn a completed send into an error for the agent;
      // the app's AuditSink is responsible for alerting on its own failures.
    }
  }

  async function callTool(name: string, rawArgs: unknown): Promise<CallOutcome> {
    const args = rawArgs ?? {};
    const meta: Record<string, unknown> = { args: redactArgs(args), legacy_key: auth.legacy };
    const fail = async (e: GatewayError, target: string | null, outcome: AuditEntry['outcome']) => {
      if (e.detail) meta.detail = e.detail;
      await audit(name, target, outcome, e, meta);
      return { isError: true, payload: toolError(e) } satisfies CallOutcome;
    };

    if (!isToolName(name)) return fail(gatewayError('not_found', 'unknown_tool'), null, 'rejected');

    // R3.4: scope first — no lookup, no side effect.
    if (!auth.scopes.has(TOOL_SCOPES[name])) {
      return fail(gatewayError('forbidden_scope', TOOL_SCOPES[name]), null, 'rejected');
    }

    const parsed = TOOL_SCHEMAS[name].safeParse(args);
    if (!parsed.success) {
      return fail(gatewayError('invalid_input', firstIssue(parsed.error.issues)), null, 'rejected');
    }
    const parsedArgs = parsed.data as { account?: string };

    let target: string | null = null;
    try {
      const acc =
        name === 'list_accounts'
          ? ok<AccountRef | null>(null)
          : await resolveAccount(deps, auth, name, parsedArgs.account);
      if (!acc.ok) return fail(acc.error, null, 'rejected');
      target = acc.value?.id ?? null;

      const ctx: ToolContext = {
        deps,
        auth,
        tool: name,
        // list_accounts never reads ctx.account
        account: acc.value ?? (null as unknown as AccountRef),
        now: now(),
        randomId,
        gateCalls: 0,
        auditMeta: meta,
      };
      const handler = HANDLERS[name] as (
        c: ToolContext,
        a: unknown,
      ) => Promise<Result<ToolPayload>>;
      const r = await handler(ctx, parsed.data);

      if (SEND_TOOL_SET.has(name) && r.ok && ctx.gateCalls !== 1) {
        // Programmer error: a send tool succeeded without exactly one gate call (S13).
        return fail(gatewayError('internal', 'send_gate_bypassed'), target, 'error');
      }
      if (!r.ok) {
        const outcome = r.error.code === 'internal' ? 'error' : 'rejected';
        return fail(r.error, target, outcome);
      }
      await audit(name, target, 'ok', null, meta);
      return { isError: false, payload: r.value };
    } catch {
      return fail(gatewayError('internal', 'handler_threw', { transient: false }), target, 'error');
    }
  }

  return { callTool, requestId };
}

export type ToolRuntime = ReturnType<typeof createToolRuntime>;
