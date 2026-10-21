import { describe, expect, it, vi } from 'vitest';
import {
  LocalTranscriber,
  SonioxTranscriber,
  TranscriberError,
  createTranscriber,
  transcribeWithRetry,
  type UnixHttp,
} from './transcriber';

const okHttp: UnixHttp = async () => ({
  status: 200,
  body: Buffer.from(
    JSON.stringify({ text: ' שלום ', duration_s: 3.2, elapsed_ms: 900, backend: 'faster-whisper' }),
  ),
});
const downHttp: UnixHttp = async () => {
  throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
};
const cfg = {
  transcriber: { socketPath: '/run/user/1000/gateway-transcriber.sock', timeoutMs: 1_000 },
};

describe('transcriber', () => {
  it('LocalTranscriber posts raw audio over the unix socket and parses the response', async () => {
    const http = vi.fn(okHttp);
    const t = new LocalTranscriber({ ...cfg.transcriber, http });
    const r = await t.transcribe(new Uint8Array([1, 2, 3]), { mime: 'audio/ogg' });
    expect(r).toEqual({
      text: 'שלום',
      durationS: 3.2,
      elapsedMs: 900,
      backend: 'local:faster-whisper',
    });
    const req = http.mock.calls[0]![0];
    expect(req).toMatchObject({
      socketPath: cfg.transcriber.socketPath,
      method: 'POST',
      path: '/transcribe',
    });
    expect(req.headers['content-length']).toBe('3');
  });

  it('LocalTranscriber maps service errors (500, connection refused) to TranscriberError', async () => {
    const t500 = new LocalTranscriber({
      ...cfg.transcriber,
      http: async () => ({ status: 500, body: Buffer.from('{}') }),
    });
    await expect(
      t500.transcribe(new Uint8Array([1]), { mime: 'audio/ogg' }),
    ).rejects.toBeInstanceOf(TranscriberError);
    const tDown = new LocalTranscriber({ ...cfg.transcriber, http: downHttp });
    await expect(tDown.transcribe(new Uint8Array([1]), { mime: 'audio/ogg' })).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it('L3.8 Soniox flag off (default): Soniox is never constructed and makes zero network calls, even when local fails', async () => {
    const makeSoniox = vi.fn();
    const fetchSpy = vi.fn();
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const t = createTranscriber(
      { ...cfg, soniox: null },
      { http: downHttp, makeSoniox, fetch: fetchSpy },
    );
    for (let i = 0; i < 5; i++) {
      expect(
        await transcribeWithRetry(t, new Uint8Array([1]), 'audio/ogg', {
          sleep: async () => undefined,
        }),
      ).toBeNull();
    }
    expect(makeSoniox).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('Soniox is appended as fallback only when enabled with a key', async () => {
    const soniox = {
      name: 'soniox',
      transcribe: vi.fn(async () => ({
        text: 'x',
        durationS: null,
        elapsedMs: 1,
        backend: 'soniox',
      })),
    };
    const t = createTranscriber(
      { ...cfg, soniox: { apiKey: 'k' } },
      { http: downHttp, makeSoniox: () => soniox },
    );
    expect((await t.transcribe(new Uint8Array([1]), { mime: 'audio/ogg' })).backend).toBe('soniox');
    expect(() => new SonioxTranscriber({ apiKey: '' })).toThrow();
  });

  it('L3.7 transcribeWithRetry retries exactly once then returns null', async () => {
    const t = {
      name: 'x',
      transcribe: vi
        .fn()
        .mockRejectedValueOnce(new Error('killed'))
        .mockResolvedValueOnce({ text: 'ok', durationS: 1, elapsedMs: 1, backend: 'x' }),
    };
    expect(
      (
        await transcribeWithRetry(t, new Uint8Array([1]), 'audio/ogg', {
          sleep: async () => undefined,
        })
      )?.text,
    ).toBe('ok');
    const bad = { name: 'x', transcribe: vi.fn().mockRejectedValue(new Error('killed')) };
    expect(
      await transcribeWithRetry(bad, new Uint8Array([1]), 'audio/ogg', {
        sleep: async () => undefined,
      }),
    ).toBeNull();
    expect(bad.transcribe).toHaveBeenCalledTimes(2);
  });
});
