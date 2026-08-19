/**
 * Cloudflare Worker for the music editor.
 *
 * The editor itself is a static SPA that does all decoding, editing and
 * encoding on the device, so this Worker deliberately does very little. It is
 * configured with `run_worker_first = ["/api/*", "/s/*"]`, which means page and
 * asset requests are served straight from Cloudflare's asset store and only the
 * two routes below actually execute code.
 *
 *   GET  /api/health          liveness probe
 *   GET  /api/config          feature flags the client reads at boot
 *   POST /api/share           store one rendered clip, return a short link
 *   GET  /s/:id               download a shared clip
 *
 * Sharing is optional: it only turns on when an R2 bucket is bound as `SHARES`.
 */

export interface Env {
  ASSETS: Fetcher;
  SHARES?: R2Bucket;
  SHARE_MAX_BYTES?: string;
  SHARE_TTL_SECONDS?: string;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Formats we hand back to a browser. Anything else is rejected on upload. */
const ALLOWED_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
};

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true, sharing: Boolean(env.SHARES) });
      }

      if (url.pathname === '/api/config') {
        return json({
          sharing: Boolean(env.SHARES),
          maxShareBytes: maxBytes(env),
          shareTtlSeconds: ttlSeconds(env),
        });
      }

      if (url.pathname === '/api/share') {
        if (request.method !== 'POST') return methodNotAllowed('POST');
        return await handleShareUpload(request, env);
      }

      if (url.pathname.startsWith('/s/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET');
        return await handleShareDownload(url.pathname.slice('/s/'.length), env);
      }

      // Anything else that reaches the Worker is an unknown path; hand it back
      // to the asset store, which serves index.html for SPA routes.
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error('unhandled worker error', err);
      return json({ error: 'internal_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleShareUpload(request: Request, env: Env): Promise<Response> {
  const bucket = env.SHARES;
  if (!bucket) {
    return json(
      { error: 'sharing_disabled', message: 'No R2 bucket is bound to this Worker.' },
      501,
    );
  }

  const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const extension = ALLOWED_TYPES[contentType];
  if (!extension) {
    return json({ error: 'unsupported_type', message: 'Share MP3 or WAV audio only.' }, 415);
  }

  const limit = maxBytes(env);
  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    return json({ error: 'too_large', maxShareBytes: limit }, 413);
  }
  if (!request.body) {
    return json({ error: 'empty_body' }, 400);
  }

  // Content-Length can lie (or be absent on a chunked upload), so buffer with a
  // hard cap rather than trusting the header.
  const body = await readCapped(request.body, limit);
  if (body === null) {
    return json({ error: 'too_large', maxShareBytes: limit }, 413);
  }
  if (body.byteLength === 0) {
    return json({ error: 'empty_body' }, 400);
  }

  const ttl = ttlSeconds(env);
  const expiresAt = Date.now() + ttl * 1000;
  const id = randomId(12);
  const key = `${id}.${extension}`;
  const filename = sanitizeFilename(request.headers.get('x-filename'), extension);

  await bucket.put(key, body, {
    httpMetadata: {
      contentType,
      cacheControl: `public, max-age=${ttl}, immutable`,
    },
    customMetadata: { expiresAt: String(expiresAt), filename },
  });

  return json({
    id: key,
    url: `/s/${key}`,
    bytes: body.byteLength,
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

async function handleShareDownload(rawKey: string, env: Env): Promise<Response> {
  const bucket = env.SHARES;
  if (!bucket) return json({ error: 'sharing_disabled' }, 501);

  const key = decodeURIComponent(rawKey);
  if (!/^[a-z0-9]{1,64}\.(mp3|wav)$/.test(key)) {
    return json({ error: 'not_found' }, 404);
  }

  const object = await bucket.get(key);
  if (!object) return json({ error: 'not_found' }, 404);

  // R2 lifecycle rules do the real cleanup; this is the belt-and-braces check so
  // an expired clip is never served even if the rule has not run yet.
  const expiresAt = Number(object.customMetadata?.expiresAt ?? 0);
  if (expiresAt && Date.now() > expiresAt) {
    await bucket.delete(key);
    return json({ error: 'expired' }, 410);
  }

  const filename = object.customMetadata?.filename ?? key;
  const headers = new Headers(SECURITY_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('content-disposition', `attachment; filename="${filename}"`);
  return new Response(object.body, { headers });
}

/** Reads a stream into memory, bailing out as soon as it exceeds `limit`. */
async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function randomId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

/** Keeps a recognisable name for the download without trusting client input. */
function sanitizeFilename(raw: string | null, extension: string): string {
  const base = (raw ?? '')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.[^.]*$/, '')
    .slice(0, 60);
  return `${base || 'clip'}.${extension}`;
}

function maxBytes(env: Env): number {
  const parsed = Number(env.SHARE_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function ttlSeconds(env: Env): number {
  const parsed = Number(env.SHARE_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { ...SECURITY_HEADERS, allow, 'content-type': 'application/json; charset=utf-8' },
  });
}
