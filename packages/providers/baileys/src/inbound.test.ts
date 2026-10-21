import { proto, type WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import { isDecryptFailure, mapStatusUpdate, normalizeInbound } from './inbound';

// Fictitious identities only.
const PN = '972500000001@s.whatsapp.net';
const LID = '123456789@lid';
const GROUP = '120363000000000001@g.us';
const ACC = 'acc-1';
const TS = 1_760_000_000;

function msg(partial: Partial<WAMessage> & { message?: proto.IMessage | null }): WAMessage {
  return {
    key: { remoteJid: LID, remoteJidAlt: PN, id: '3EB0TEST', fromMe: false },
    messageTimestamp: TS,
    pushName: 'Tester',
    ...partial,
  } as WAMessage;
}

describe('normalizeInbound', () => {
  it('maps a direct text from a LID chat with remoteJidAlt PN', () => {
    const e = normalizeInbound(msg({ message: { conversation: 'hello' } }), ACC)!;
    expect(e).toEqual({
      accountId: ACC,
      provider: 'baileys',
      providerMessageId: '3EB0TEST',
      chat: LID,
      senderPn: PN,
      senderLid: LID,
      isGroup: false,
      fromMe: false,
      type: 'text',
      text: 'hello',
      pushName: 'Tester',
      timestamp: new Date(TS * 1000).toISOString(),
      isForwarded: false,
      quotedProviderId: null,
      media: null,
      statusReplyToId: null,
    });
  });

  it('strips device suffixes and handles PN chats with LID alt', () => {
    const e = normalizeInbound(
      msg({
        key: {
          remoteJid: '972500000001:7@s.whatsapp.net',
          remoteJidAlt: '123456789:7@lid',
          id: 'X',
        },
        message: { conversation: 'x' },
      }),
      ACC,
    )!;
    expect(e.chat).toBe(PN);
    expect(e.senderPn).toBe(PN);
    expect(e.senderLid).toBe(LID);
  });

  it('maps group sender from participant (LID) + participantAlt (PN)', () => {
    const e = normalizeInbound(
      msg({
        key: { remoteJid: GROUP, participant: LID, participantAlt: PN, id: 'G1', fromMe: false },
        message: { extendedTextMessage: { text: 'hi all' } },
      }),
      ACC,
    )!;
    expect(e.isGroup).toBe(true);
    expect(e.chat).toBe(GROUP);
    expect(e.senderLid).toBe(LID);
    expect(e.senderPn).toBe(PN);
  });

  it('fromMe uses own identity', () => {
    const e = normalizeInbound(
      msg({ key: { remoteJid: LID, id: 'M', fromMe: true }, message: { conversation: 'x' } }),
      ACC,
      { pn: PN, lid: LID },
    )!;
    expect(e.fromMe).toBe(true);
    expect(e.senderPn).toBe(PN);
  });

  it('detects forwarded (isForwarded / forwardingScore) and quoted ids', () => {
    const e = normalizeInbound(
      msg({
        message: {
          extendedTextMessage: {
            text: 'fwd',
            contextInfo: { isForwarded: true, forwardingScore: 2, stanzaId: 'QUOTED1' },
          },
        },
      }),
      ACC,
    )!;
    expect(e.isForwarded).toBe(true);
    expect(e.quotedProviderId).toBe('QUOTED1');
    const f = normalizeInbound(
      msg({
        message: { imageMessage: { mimetype: 'image/jpeg', contextInfo: { forwardingScore: 1 } } },
      }),
      ACC,
    )!;
    expect(f.isForwarded).toBe(true);
  });

  it('maps a voice note (ptt) with seconds', () => {
    const e = normalizeInbound(
      msg({
        message: { audioMessage: { ptt: true, seconds: 42, mimetype: 'audio/ogg; codecs=opus' } },
      }),
      ACC,
    )!;
    expect(e.type).toBe('voice');
    expect(e.media).toEqual({ mime: 'audio/ogg; codecs=opus', seconds: 42 });
    const a = normalizeInbound(
      msg({ message: { audioMessage: { ptt: false, seconds: 5, mimetype: 'audio/mpeg' } } }),
      ACC,
    )!;
    expect(a.type).toBe('audio');
  });

  it('maps image/video/document with captions', () => {
    expect(
      normalizeInbound(
        msg({ message: { imageMessage: { caption: 'c', mimetype: 'image/png' } } }),
        ACC,
      ),
    ).toMatchObject({ type: 'image', text: 'c', media: { mime: 'image/png' } });
    expect(
      normalizeInbound(
        msg({ message: { videoMessage: { mimetype: 'video/mp4', seconds: 9 } } }),
        ACC,
      ),
    ).toMatchObject({ type: 'video', media: { mime: 'video/mp4', seconds: 9 } });
    expect(
      normalizeInbound(
        msg({
          message: {
            documentWithCaptionMessage: {
              message: { documentMessage: { mimetype: 'application/pdf', caption: 'doc' } },
            },
          },
        }),
        ACC,
      ),
    ).toMatchObject({ type: 'document', text: 'doc', media: { mime: 'application/pdf' } });
  });

  it('maps view-once (wrapper and flag) as view_once', () => {
    const e = normalizeInbound(
      msg({
        message: {
          viewOnceMessageV2: {
            message: { imageMessage: { mimetype: 'image/jpeg', viewOnce: true } },
          },
        },
      }),
      ACC,
    )!;
    expect(e.type).toBe('view_once');
    expect(e.media?.mime).toBe('image/jpeg');
  });

  it.each([
    ['sticker', { stickerMessage: { mimetype: 'image/webp' } }],
    ['location', { locationMessage: { degreesLatitude: 32.1, degreesLongitude: 34.8 } }],
    ['contact', { contactMessage: { displayName: 'X', vcard: 'BEGIN:VCARD' } }],
    ['poll', { pollCreationMessageV3: { name: 'Q?', options: [{ optionName: 'a' }] } }],
  ] as const)('maps %s', (type, message) => {
    expect(normalizeInbound(msg({ message: message as proto.IMessage }), ACC)?.type).toBe(type);
  });

  it('location/contact never leak coordinates or vcards into text', () => {
    const e = normalizeInbound(
      msg({ message: { locationMessage: { degreesLatitude: 32.1, degreesLongitude: 34.8 } } }),
      ACC,
    )!;
    expect(e.text).toBeNull();
  });

  it('maps a reaction with the target id as quoted', () => {
    const e = normalizeInbound(
      msg({ message: { reactionMessage: { text: '👍', key: { id: 'TARGET', remoteJid: LID } } } }),
      ACC,
    )!;
    expect(e).toMatchObject({ type: 'reaction', text: '👍', quotedProviderId: 'TARGET' });
  });

  it('maps status replies to statusReplyToId (not quoted)', () => {
    const e = normalizeInbound(
      msg({
        message: {
          extendedTextMessage: {
            text: 'nice',
            contextInfo: { remoteJid: 'status@broadcast', stanzaId: 'STATUS1', participant: PN },
          },
        },
      }),
      ACC,
    )!;
    expect(e.statusReplyToId).toBe('STATUS1');
    expect(e.quotedProviderId).toBeNull();
  });

  it('maps a status post (status@broadcast) with participant as sender', () => {
    const e = normalizeInbound(
      msg({
        key: { remoteJid: 'status@broadcast', participant: LID, participantAlt: PN, id: 'S' },
        message: { imageMessage: { mimetype: 'image/jpeg' } },
      }),
      ACC,
    )!;
    expect(e.chat).toBe('status@broadcast');
    expect(e.senderPn).toBe(PN);
    expect(e.isGroup).toBe(false);
  });

  it('maps interactive replies', () => {
    const e = normalizeInbound(
      msg({
        message: { buttonsResponseMessage: { selectedDisplayText: 'Yes', selectedButtonId: '1' } },
      }),
      ACC,
    )!;
    expect(e).toMatchObject({ type: 'interactive_reply', text: 'Yes' });
  });

  it('unwraps ephemeral messages', () => {
    const e = normalizeInbound(
      msg({ message: { ephemeralMessage: { message: { conversation: 'eph' } } } }),
      ACC,
    )!;
    expect(e).toMatchObject({ type: 'text', text: 'eph' });
  });

  it('ignores protocol / key-distribution-only messages and empty ones', () => {
    expect(normalizeInbound(msg({ message: { protocolMessage: { type: 0 } } }), ACC)).toBeNull();
    expect(
      normalizeInbound(msg({ message: { senderKeyDistributionMessage: { groupId: GROUP } } }), ACC),
    ).toBeNull();
    expect(normalizeInbound(msg({ message: null }), ACC)).toBeNull();
  });

  it('flags CIPHERTEXT stubs as decrypt failures', () => {
    const m = msg({
      message: null,
      messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
      messageStubParameters: ['No session found'],
    });
    expect(isDecryptFailure(m)).toBe(true);
    expect(normalizeInbound(m, ACC)).toBeNull();
    expect(isDecryptFailure(msg({ message: { conversation: 'x' } }))).toBe(false);
  });
});

describe('mapStatusUpdate', () => {
  it.each([
    [proto.WebMessageInfo.Status.ERROR, 'failed'],
    [proto.WebMessageInfo.Status.SERVER_ACK, 'sent'],
    [proto.WebMessageInfo.Status.DELIVERY_ACK, 'delivered'],
    [proto.WebMessageInfo.Status.READ, 'read'],
    [proto.WebMessageInfo.Status.PLAYED, 'read'],
  ])('status %s → %s', (status, expected) => {
    expect(
      mapStatusUpdate({ key: { remoteJid: LID, id: 'A', fromMe: true }, update: { status } }),
    ).toEqual({ providerMessageId: 'A', chat: LID, status: expected });
  });

  it('ignores updates for messages we did not send or without status', () => {
    expect(
      mapStatusUpdate({ key: { remoteJid: LID, id: 'A', fromMe: false }, update: { status: 3 } }),
    ).toBeNull();
    expect(
      mapStatusUpdate({ key: { remoteJid: LID, id: 'A', fromMe: true }, update: {} }),
    ).toBeNull();
  });
});
