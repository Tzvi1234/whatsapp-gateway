/**
 * Speech-to-text for voice notes (ARCH §4.7). The local `gateway-transcriber` service (unix
 * socket, faster-whisper ivrit-ai) is the default. Soniox is paid and OFF by default: it is only
 * constructed when SONIOX_ENABLED=true AND SONIOX_API_KEY is set (TEST-PLAN L3.8).
 */
import http from 'node:http';

export interface Transcript {
  text: string;
  durationS: number | null;
  elapsedMs: number | null;
  backend: string;
}

export interface Transcriber {
  readonly name: string;
  transcribe(audio: Uint8Array, opts: { mime: string }): Promise<Transcript>;
}

export class TranscriberError extends Error {
  constructor(
    readonly backend: string,
    readonly reason: string,
  ) {
    super(`${backend}: ${reason}`);
    this.name = 'TranscriberError';
  }
}

// ---------------------------------------------------------------------------------------------
// Local service over a unix socket: POST /transcribe (raw audio) → {text,duration_s,elapsed_ms,backend}
// ---------------------------------------------------------------------------------------------

export interface HttpResult {
  status: number;
  body: Buffer;
}

/** HTTP over a unix socket; injectable so tests never open sockets. */
export type UnixHttp = (req: {
  socketPath: string;
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  timeoutMs: number;
}) => Promise<HttpResult>;

export const nodeUnixHttp: UnixHttp = (req) =>
  new Promise((resolve, reject) => {
    const r = http.request(
      {
        socketPath: req.socketPath,
        method: req.method,
        path: req.path,
        headers: req.headers,
        timeout: req.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new TranscriberError('local', 'timeout')));
    r.on('error', reject);
    if (req.body) r.end(Buffer.from(req.body.buffer, req.body.byteOffset, req.body.byteLength));
    else r.end();
  });

export class LocalTranscriber implements Transcriber {
  readonly name = 'local';
  constructor(private readonly opts: { socketPath: string; timeoutMs: number; http?: UnixHttp }) {}

  async transcribe(audio: Uint8Array, opts: { mime: string }): Promise<Transcript> {
    if (audio.byteLength === 0) throw new TranscriberError(this.name, 'empty_audio');
    let res: HttpResult;
    try {
      res = await (this.opts.http ?? nodeUnixHttp)({
        socketPath: this.opts.socketPath,
        method: 'POST',
        path: '/transcribe',
        headers: { 'content-type': opts.mime, 'content-length': String(audio.byteLength) },
        body: audio,
        timeoutMs: this.opts.timeoutMs,
      });
    } catch (err) {
      // ECONNREFUSED/ENOENT = service down or restarting (e.g. OOM-killed, L3.7).
      const code = (err as { code?: string }).code;
      throw new TranscriberError(this.name, code ?? (err as Error).message ?? 'request_failed');
    }
    if (res.status !== 200) throw new TranscriberError(this.name, `http_${res.status}`);
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new TranscriberError(this.name, 'bad_json');
    }
    if (typeof j.text !== 'string') throw new TranscriberError(this.name, 'no_text');
    return {
      text: j.text.trim(),
      durationS: typeof j.duration_s === 'number' ? j.duration_s : null,
      elapsedMs: typeof j.elapsed_ms === 'number' ? j.elapsed_ms : null,
      backend: typeof j.backend === 'string' ? `local:${j.backend}` : 'local',
    };
  }

  async health(): Promise<boolean> {
    try {
      const r = await (this.opts.http ?? nodeUnixHttp)({
        socketPath: this.opts.socketPath,
        method: 'GET',
        path: '/health',
        headers: {},
        timeoutMs: 5_000,
      });
      return r.status === 200;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Soniox (paid, flag OFF by default). Async file API: upload → transcription → poll → transcript.
// ---------------------------------------------------------------------------------------------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SonioxOptions {
  apiKey: string;
  fetch?: FetchLike;
  baseUrl?: string;
  model?: string;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class SonioxTranscriber implements Transcriber {
  readonly name = 'soniox';
  readonly #o: Required<Omit<SonioxOptions, 'fetch' | 'sleep'>> & {
    fetch: FetchLike;
    sleep: (ms: number) => Promise<void>;
  };

  constructor(opts: SonioxOptions) {
    if (!opts.apiKey) throw new Error('SonioxTranscriber requires an API key');
    this.#o = {
      apiKey: opts.apiKey,
      fetch: opts.fetch ?? ((u, i) => fetch(u, i)),
      baseUrl: opts.baseUrl ?? 'https://api.soniox.com/v1',
      model: opts.model ?? 'stt-async-preview',
      pollMs: opts.pollMs ?? 1_000,
      timeoutMs: opts.timeoutMs ?? 120_000,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  async #json(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await this.#o.fetch(`${this.#o.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.#o.apiKey}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new TranscriberError(this.name, `http_${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async transcribe(audio: Uint8Array, opts: { mime: string }): Promise<Transcript> {
    const started = Date.now();
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(audio)], { type: opts.mime }), 'voice.ogg');
    const file = await this.#json('/files', { method: 'POST', body: form });
    const fileId = String(file.id ?? '');
    try {
      const tr = await this.#json('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: fileId, model: this.#o.model, language_hints: ['he'] }),
      });
      const id = String(tr.id ?? '');
      for (;;) {
        const s = await this.#json(`/transcriptions/${id}`, { method: 'GET' });
        if (s.status === 'completed') break;
        if (s.status === 'error') throw new TranscriberError(this.name, 'job_error');
        if (Date.now() - started > this.#o.timeoutMs)
          throw new TranscriberError(this.name, 'timeout');
        await this.#o.sleep(this.#o.pollMs);
      }
      const t = await this.#json(`/transcriptions/${id}/transcript`, { method: 'GET' });
      if (typeof t.text !== 'string') throw new TranscriberError(this.name, 'no_text');
      return {
        text: t.text.trim(),
        durationS: null,
        elapsedMs: Date.now() - started,
        backend: 'soniox',
      };
    } finally {
      // Do not keep audio at the vendor longer than needed.
      await this.#o
        .fetch(`${this.#o.baseUrl}/files/${fileId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${this.#o.apiKey}` },
        })
        .catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------------------------

/** Tries each backend in order. */
export class ChainTranscriber implements Transcriber {
  readonly name: string;
  constructor(private readonly chain: readonly Transcriber[]) {
    if (chain.length === 0) throw new Error('empty transcriber chain');
    this.name = chain.map((t) => t.name).join('>');
  }
  async transcribe(audio: Uint8Array, opts: { mime: string }): Promise<Transcript> {
    let last: unknown = null;
    for (const t of this.chain) {
      try {
        return await t.transcribe(audio, opts);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }
}

export interface TranscriberConfig {
  transcriber: { socketPath: string; timeoutMs: number };
  soniox: { apiKey: string } | null;
}

/**
 * Local first; Soniox appended ONLY when enabled with a key. With the flag off the Soniox class is
 * never instantiated, so no request can reach Soniox (L3.8).
 */
export function createTranscriber(
  cfg: TranscriberConfig,
  deps: {
    http?: UnixHttp;
    makeSoniox?: (o: SonioxOptions) => Transcriber;
    fetch?: FetchLike;
  } = {},
): Transcriber {
  const local = new LocalTranscriber({
    ...cfg.transcriber,
    ...(deps.http ? { http: deps.http } : {}),
  });
  if (!cfg.soniox?.apiKey) return local;
  const make = deps.makeSoniox ?? ((o: SonioxOptions) => new SonioxTranscriber(o));
  return new ChainTranscriber([
    local,
    make({ apiKey: cfg.soniox.apiKey, ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
  ]);
}

/**
 * Retry once (L3.7: the service may have been OOM-killed mid-job and is restarting), then give
 * up with `null`. Never throws.
 */
export async function transcribeWithRetry(
  t: Transcriber,
  audio: Uint8Array,
  mime: string,
  opts: {
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onError?: (err: unknown, attempt: number) => void;
  } = {},
): Promise<Transcript | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await t.transcribe(audio, { mime });
    } catch (err) {
      opts.onError?.(err, attempt);
      if (attempt === 1) await sleep(opts.retryDelayMs ?? 5_000);
    }
  }
  return null;
}
