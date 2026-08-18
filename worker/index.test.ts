import { beforeEach, describe, expect, it } from 'vitest';
import worker, { type Env } from './index';

interface StoredObject {
  body: Uint8Array;
  httpMetadata: { contentType?: string; cacheControl?: string };
  customMetadata: Record<string, string>;
}

/** Enough of the R2 surface for the two calls the Worker makes. */
class FakeBucket {
  readonly store = new Map<string, StoredObject>();

  async put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: StoredObject['httpMetadata']; customMetadata?: Record<string, string> },
  ): Promise<void> {
    this.store.set(key, {
      body: value,
      httpMetadata: options?.httpMetadata ?? {},
      customMetadata: options?.customMetadata ?? {},
    });
  }

  async get(key: string) {
    const stored = this.store.get(key);
    if (!stored) return null;
    return {
      body: stored.body,
      httpEtag: `"${key}"`,
      customMetadata: stored.customMetadata,
      writeHttpMetadata: (headers: Headers) => {
        if (stored.httpMetadata.contentType) headers.set('content-type', stored.httpMetadata.contentType);
        if (stored.httpMetadata.cacheControl) headers.set('cache-control', stored.httpMetadata.cacheControl);
      },
    };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const ASSETS = {
  fetch: async () => new Response('static asset', { status: 200 }),
} as unknown as Env['ASSETS'];

let bucket: FakeBucket;

function makeEnv(withBucket = true): Env {
  const env: Env = { ASSETS, SHARE_MAX_BYTES: '1000', SHARE_TTL_SECONDS: '60' };
  if (withBucket) env.SHARES = bucket as unknown as NonNullable<Env['SHARES']>;
  return env;
}

function post(body: BodyInit, headers: Record<string, string>): Request {
  return new Request('https://editor.test/api/share', { method: 'POST', body, headers });
}

beforeEach(() => {
  bucket = new FakeBucket();
});

describe('GET /api/health', () => {
  it('reports liveness and whether sharing is wired up', async () => {
    const withBucket = await worker.fetch(new Request('https://editor.test/api/health'), makeEnv());
    expect(withBucket.status).toBe(200);
    expect(await withBucket.json()).toEqual({ ok: true, sharing: true });

    const without = await worker.fetch(new Request('https://editor.test/api/health'), makeEnv(false));
    expect(await without.json()).toEqual({ ok: true, sharing: false });
  });
});

describe('GET /api/config', () => {
  it('exposes the configured limits', async () => {
    const response = await worker.fetch(new Request('https://editor.test/api/config'), makeEnv());
    expect(await response.json()).toEqual({
      sharing: true,
      maxShareBytes: 1000,
      shareTtlSeconds: 60,
    });
  });

  it('falls back to defaults when the vars are missing', async () => {
    const response = await worker.fetch(new Request('https://editor.test/api/config'), {
      ASSETS,
      SHARES: bucket as unknown as NonNullable<Env['SHARES']>,
    });
    const body = (await response.json()) as { maxShareBytes: number; shareTtlSeconds: number };
    expect(body.maxShareBytes).toBe(25 * 1024 * 1024);
    expect(body.shareTtlSeconds).toBe(7 * 24 * 60 * 60);
  });
});

describe('POST /api/share', () => {
  it('stores audio and returns a link', async () => {
    const audio = new Uint8Array(128).fill(7);
    const response = await worker.fetch(
      post(audio, { 'content-type': 'audio/mpeg', 'x-filename': 'my song.mp3' }),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; url: string; bytes: number };
    expect(body.bytes).toBe(128);
    expect(body.id).toMatch(/^[a-z0-9]{12}\.mp3$/);
    expect(body.url).toBe(`/s/${body.id}`);
    expect(bucket.store.get(body.id)?.customMetadata.filename).toBe('my song.mp3');
  });

  it('refuses to run without a bucket binding', async () => {
    const response = await worker.fetch(
      post(new Uint8Array(4), { 'content-type': 'audio/mpeg' }),
      makeEnv(false),
    );
    expect(response.status).toBe(501);
  });

  it('rejects formats it will not serve back', async () => {
    const response = await worker.fetch(
      post(new Uint8Array(4), { 'content-type': 'application/zip' }),
      makeEnv(),
    );
    expect(response.status).toBe(415);
  });

  it('rejects an upload whose declared length exceeds the limit', async () => {
    const response = await worker.fetch(
      post(new Uint8Array(2000), { 'content-type': 'audio/wav' }),
      makeEnv(),
    );
    expect(response.status).toBe(413);
    expect(bucket.store.size).toBe(0);
  });

  it('rejects an oversized upload that hides its length behind a stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 4 × 400 bytes overruns the 1000-byte cap partway through.
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(400));
        controller.close();
      },
    });
    const request = new Request('https://editor.test/api/share', {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'audio/wav' },
      // @ts-expect-error `duplex` is required for a streaming body in Node.
      duplex: 'half',
    });

    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(413);
    expect(bucket.store.size).toBe(0);
  });

  it('rejects an empty upload', async () => {
    const response = await worker.fetch(
      post(new Uint8Array(0), { 'content-type': 'audio/wav' }),
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });

  it('strips path characters out of the download filename', async () => {
    const response = await worker.fetch(
      post(new Uint8Array(8), { 'content-type': 'audio/wav', 'x-filename': '../../etc/passwd"' }),
      makeEnv(),
    );
    const { id } = (await response.json()) as { id: string };
    const filename = bucket.store.get(id)?.customMetadata.filename ?? '';
    expect(filename).not.toContain('/');
    expect(filename).not.toContain('"');
    expect(filename.endsWith('.wav')).toBe(true);
  });

  it('only accepts POST', async () => {
    const response = await worker.fetch(new Request('https://editor.test/api/share'), makeEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});

describe('GET /s/:id', () => {
  async function share(contentType = 'audio/wav'): Promise<string> {
    const response = await worker.fetch(
      post(new Uint8Array([1, 2, 3, 4]), { 'content-type': contentType, 'x-filename': 'clip.wav' }),
      makeEnv(),
    );
    return ((await response.json()) as { id: string }).id;
  }

  it('serves a stored clip as a download', async () => {
    const id = await share();
    const response = await worker.fetch(new Request(`https://editor.test/s/${id}`), makeEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('content-disposition')).toContain('clip.wav');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('404s on a key that was never stored', async () => {
    const response = await worker.fetch(new Request('https://editor.test/s/abcdef123456.wav'), makeEnv());
    expect(response.status).toBe(404);
  });

  it('404s on a key that does not match the expected shape', async () => {
    const response = await worker.fetch(
      new Request('https://editor.test/s/..%2Fsecret.txt'),
      makeEnv(),
    );
    expect(response.status).toBe(404);
  });

  it('expires a clip past its TTL and removes it', async () => {
    const id = await share();
    const stored = bucket.store.get(id)!;
    stored.customMetadata.expiresAt = String(Date.now() - 1000);

    const response = await worker.fetch(new Request(`https://editor.test/s/${id}`), makeEnv());
    expect(response.status).toBe(410);
    expect(bucket.store.has(id)).toBe(false);
  });
});

describe('fallback routing', () => {
  it('hands unknown paths back to the asset store', async () => {
    const response = await worker.fetch(new Request('https://editor.test/some/spa/route'), makeEnv());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('static asset');
  });

  it('sets hardening headers on its own responses', async () => {
    const response = await worker.fetch(new Request('https://editor.test/api/health'), makeEnv());
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
