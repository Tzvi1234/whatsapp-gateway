import { z } from 'zod';
import type {
  CapabilitySupport,
  DeliveryMode,
  OutboundInteractive,
  OutboundMedia,
} from '@htz/core';

export const MAX_REPLY_OPTIONS = 10;
const MAX_NATIVE_BUTTONS = 3;
const NAME_TOKEN = /\{name\}/g;

/** Only plain http(s) links without credentials (R1.8). */
export const safeLinkSchema = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'only http(s) links are allowed');

const UNSAFE_SCHEME = /\b(?:javascript|data|vbscript|file):/i;

export const replyOptionSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((v) => !UNSAFE_SCHEME.test(v), 'unsafe link scheme in label'),
  url: safeLinkSchema.optional(),
});

export const replyMediaSchema = z.object({
  storagePath: z.string().min(1),
  mime: z.string().min(1),
});

export const replyConfigSchema = z.object({
  text: z
    .string()
    .max(4096)
    .refine((v) => !UNSAFE_SCHEME.test(v), 'unsafe link scheme in text'),
  options: z.array(replyOptionSchema).max(MAX_REPLY_OPTIONS).default([]),
  media: replyMediaSchema.nullable().default(null),
  /** Legacy "try native buttons" flag (now gated by the account capability). */
  nativeButtons: z.boolean().default(false),
});

export type ReplyOption = z.infer<typeof replyOptionSchema>;
export type ReplyConfig = z.infer<typeof replyConfigSchema>;

export interface ReplyCapabilities {
  nativeButtons: CapabilitySupport;
  lists: CapabilitySupport;
}

export interface RenderedReply {
  /** Message text, or the media caption when `media` is set. */
  text: string;
  media: OutboundMedia | null;
  /** Set only when native interactive is actually used. */
  interactive: OutboundInteractive | null;
  /** `native` interactive, `fallback` when native was requested but numbered text is sent, else `text`. */
  deliveryMode: DeliveryMode;
}

/** Push names are untrusted: strip control/format chars and braces, cap length. */
export function sanitizePushName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .replace(/[\p{Cc}\p{Cf}{}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

/** Replace `{name}`; with an empty name, remove it without leaving dangling spaces/punctuation (R1.6). */
export function applyName(text: string, pushName: string | null | undefined): string {
  const name = sanitizePushName(pushName);
  if (name) return text.replace(NAME_TOKEN, () => name);
  return text
    .replace(NAME_TOKEN, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([,.!?:;،])/g, '$1')
        .replace(/^[ \t]*[,;:،][ \t]*/, '')
        .trim(),
    )
    .join('\n');
}

export function renderOptionsList(options: readonly ReplyOption[]): string {
  return options.map((o, i) => `${i + 1}. ${o.label}${o.url ? ` (${o.url})` : ''}`).join('\n');
}

/**
 * Render a status-reply (R1.6-R1.9). Native interactive is attempted only when requested,
 * there is no media (R1.7), no option carries a link, and the capability is `supported`;
 * otherwise options become a numbered list and a requested native send is marked `fallback`.
 */
export function renderReply(
  config: ReplyConfig,
  ctx: { pushName: string | null | undefined; capabilities: ReplyCapabilities },
): RenderedReply {
  const body = applyName(config.text, ctx.pushName);
  const media: OutboundMedia | null = config.media
    ? { storagePath: config.media.storagePath, mime: config.media.mime }
    : null;
  const options = config.options;

  if (config.nativeButtons && options.length > 0 && !media && options.every((o) => !o.url)) {
    const style = options.length <= MAX_NATIVE_BUTTONS ? 'buttons' : 'list';
    const support = style === 'buttons' ? ctx.capabilities.nativeButtons : ctx.capabilities.lists;
    if (support === 'supported') {
      return {
        text: body,
        media: null,
        interactive: { body, options: options.map((o) => o.label), style },
        deliveryMode: 'native',
      };
    }
  }

  const list = options.length > 0 ? renderOptionsList(options) : '';
  const text = [body, list].filter((s) => s.length > 0).join('\n\n');
  const requestedNative = config.nativeButtons && options.length > 0;
  return {
    text,
    media: media ? { ...media, ...(text ? { caption: text } : {}) } : null,
    interactive: null,
    deliveryMode: requestedNative ? 'fallback' : 'text',
  };
}
