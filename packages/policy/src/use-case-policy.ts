import { z } from 'zod';
import { USE_CASES, type UseCase } from '@htz/core';

/** `accounts.use_case_policy` (jsonb), ARCH §7.6. Unknown keys are ignored; missing keys fail closed. */
export const useCasePolicySchema = z.object({
  allowed_use_cases: z.array(z.enum(USE_CASES)).default([]),
  /** Default false: the server never starts conversations on its own. */
  may_initiate: z.boolean().default(false),
  /** E.164 (or local IL) numbers; relay accounts only accept / initiate to these. */
  sender_allowlist: z.array(z.string()).default([]),
  /** Agent-relay (Lia) account. */
  relay: z.boolean().default(false),
});

export type UseCasePolicy = z.infer<typeof useCasePolicySchema>;

export function parseUseCasePolicy(raw: unknown): UseCasePolicy | null {
  const r = useCasePolicySchema.safeParse(raw ?? {});
  return r.success ? r.data : null;
}

export function isUseCaseAllowed(policy: UseCasePolicy, useCase: UseCase): boolean {
  return policy.allowed_use_cases.includes(useCase);
}
