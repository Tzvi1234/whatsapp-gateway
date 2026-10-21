import type { Result } from '@htz/core';
import type { AuthContext } from './auth';
import type { AccountRef, McpDeps } from './deps';
import type { ToolName } from './tools';

export interface ToolContext {
  readonly deps: McpDeps;
  readonly auth: AuthContext;
  readonly tool: ToolName;
  /** Resolved account (every tool except `list_accounts`). */
  readonly account: AccountRef;
  readonly now: Date;
  readonly randomId: () => string;
  /** Incremented by the shared send path; checked by the runtime for send tools. */
  gateCalls: number;
  /** Extra non-sensitive audit fields (e.g. `dedup`, `duplicate`). */
  readonly auditMeta: Record<string, unknown>;
}

export type ToolPayload = { ok: true } & Record<string, unknown>;
export type ToolHandler<A> = (ctx: ToolContext, args: A) => Promise<Result<ToolPayload>>;
