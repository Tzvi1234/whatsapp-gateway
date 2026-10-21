import { z } from 'zod';
import { err, gatewayError, ok, type Result } from '@htz/core';
import { GraphClient } from './graph-client';

/** Message templates approved in Meta Business Manager (we never author templates). */

export type TemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
export type TemplateStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED' | 'DISABLED' | 'OTHER';

export interface TemplateSummary {
  id: string | null;
  name: string;
  language: string;
  category: TemplateCategory | 'OTHER';
  status: TemplateStatus;
  /** Number of `{{n}}` placeholders in the BODY component. */
  bodyParamCount: number;
  bodyText: string | null;
}

const componentSchema = z.object({ type: z.string(), text: z.string().optional() }).loose();
const templateSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    language: z.string(),
    status: z.string(),
    category: z.string().optional(),
    components: z.array(componentSchema).optional(),
  })
  .loose();
const pageSchema = z.object({
  data: z.array(z.unknown()).default([]),
  paging: z
    .object({
      cursors: z.object({ after: z.string().optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
});

const CATEGORIES = new Set(['UTILITY', 'MARKETING', 'AUTHENTICATION']);
const STATUSES = new Set(['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED']);

/** Counts distinct positional placeholders `{{1}}`, `{{2}}` … in a template body. */
export function countBodyParams(text: string | null | undefined): number {
  if (!text) return 0;
  const set = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) set.add(m[1]!);
  return set.size;
}

export function toTemplateSummary(raw: z.infer<typeof templateSchema>): TemplateSummary {
  const body = raw.components?.find((c) => c.type.toUpperCase() === 'BODY')?.text ?? null;
  const cat = (raw.category ?? '').toUpperCase();
  const st = raw.status.toUpperCase();
  return {
    id: raw.id ?? null,
    name: raw.name,
    language: raw.language,
    category: CATEGORIES.has(cat) ? (cat as TemplateCategory) : 'OTHER',
    status: STATUSES.has(st) ? (st as TemplateStatus) : 'OTHER',
    bodyParamCount: countBodyParams(body),
    bodyText: body,
  };
}

export interface ListTemplatesOptions {
  /** Defaults to APPROVED only. Pass `null` for every status. */
  status?: TemplateStatus | null;
  maxPages?: number;
}

/** `GET /{waba_id}/message_templates`, following cursor paging. */
export async function listTemplates(
  graph: GraphClient,
  creds: { wabaId: string; accessToken: string },
  opts: ListTemplatesOptions = {},
): Promise<Result<TemplateSummary[]>> {
  if (!/^\d{5,20}$/.test(creds.wabaId)) return err(gatewayError('invalid_input', 'bad_waba_id'));
  const status = opts.status === undefined ? 'APPROVED' : opts.status;
  const out: TemplateSummary[] = [];
  let after: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 10); page++) {
    const r = await graph.request<unknown>(
      'GET',
      `${creds.wabaId}/message_templates`,
      creds.accessToken,
      {
        query: {
          fields: 'id,name,language,status,category,components',
          limit: 100,
          status: status ?? undefined,
          after,
        },
      },
    );
    if (!r.ok) return r;
    const p = pageSchema.safeParse(r.value);
    if (!p.success) return err(gatewayError('provider_error', 'graph_bad_template_page'));
    for (const raw of p.data.data) {
      const t = templateSchema.safeParse(raw);
      if (t.success) out.push(toTemplateSummary(t.data));
    }
    after = p.data.paging?.next ? p.data.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return ok(status ? out.filter((t) => t.status === status) : out);
}

export interface TemplateFilter {
  name?: string;
  language?: string;
  category?: TemplateCategory;
  status?: TemplateStatus;
}

/** Pure filter used by the dashboard and MCP `list_templates`. */
export function filterTemplates(
  list: readonly TemplateSummary[],
  f: TemplateFilter = {},
): TemplateSummary[] {
  const name = f.name?.toLowerCase();
  return list.filter(
    (t) =>
      (!name || t.name.toLowerCase().includes(name)) &&
      (!f.language || t.language === f.language) &&
      (!f.category || t.category === f.category) &&
      (!f.status || t.status === f.status),
  );
}

/** Utility templates only (phase 1 Cloud reminders policy). */
export function utilityTemplates(list: readonly TemplateSummary[]): TemplateSummary[] {
  return filterTemplates(list, { category: 'UTILITY', status: 'APPROVED' });
}
