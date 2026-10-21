import { describe, expect, it } from 'vitest';
import { buildRelayPayload, newBatchId, routeInboundType, toRelayMessage } from './payload';

const inbound = {
  messageId: 'msg-1',
  threadId: 't',
  from: '+972559014410',
  timestamp: '2026-10-21T12:00:00.000Z',
  type: 'text' as const,
  text: 'שלום',
  mediaUrl: null,
  replyToId: 'q-1',
  isForwarded: true,
};

describe('relay payload', () => {
  it('L3.10 payload has exactly the contract fields', () => {
    const p = buildRelayPayload({
      batchId: 'batch-1',
      isTest: false,
      messages: [{ ...toRelayMessage(inbound, null), extra: 'x' } as never],
    });
    expect(Object.keys(p)).toEqual(['batch_id', 'is_test', 'messages']);
    expect(Object.keys(p.messages[0]!)).toEqual([
      'message_id',
      'from',
      'timestamp',
      'type',
      'text',
      'media_url',
      'transcript',
      'reply_to_id',
      'is_forwarded',
    ]);
  });

  it('L1.6 forwarded message keeps is_forwarded and text', () => {
    expect(toRelayMessage(inbound, null)).toMatchObject({ is_forwarded: true, text: 'שלום' });
  });

  it('L5.1 test payload carries is_test true', () => {
    expect(buildRelayPayload({ batchId: 'b', isTest: true, messages: [] }).is_test).toBe(true);
  });

  it('L4.8 resend with the stored batch id yields an identical payload', () => {
    const messages = [toRelayMessage(inbound, null)];
    const a = buildRelayPayload({ batchId: 'batch-1', isTest: false, messages });
    const b = buildRelayPayload({ batchId: 'batch-1', isTest: false, messages });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('batch ids are uuid v4 and unique', () => {
    const a = newBatchId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newBatchId()).not.toBe(a);
  });

  it('maps inbound types to the relay enum', () => {
    expect(routeInboundType('interactive_reply')).toEqual({ relay: 'text' });
    expect(routeInboundType('voice')).toEqual({ relay: 'voice' });
    expect(routeInboundType('sticker')).toEqual({ unsupported: true });
    expect(routeInboundType('reaction')).toEqual({ ignored: true });
  });
});
