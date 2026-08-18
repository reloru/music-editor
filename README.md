# Music Editor

A mobile-first MP3 and WAV editor that runs entirely in the browser and is served
from a Cloudflare Worker. Built and tuned for an iPhone 14 Pro Max, but it works
on any modern browser.

Audio never leaves the device. Decoding, editing and encoding all happen in the
phone's own Web Audio stack, so there is no upload, no queue, no account, and no
per-minute cost — the Worker only ships static files.

## What it does

**Editing** — trim to selection, cut, copy, paste, delete, silence, fade in,
fade out, peak normalise, gain in dB, reverse, tape-style speed change, DC offset
removal. Every edit is undoable, and cuts get a 3 ms taper so they do not click.

**Transport** — play, pause, return to start, loop the selection, scrub, and a
playhead that keeps itself on screen while playing.

**Waveform** — stereo lanes with a peak envelope and an RMS body, a time ruler,
clipping markers, and a peak pyramid behind it so a five-minute track redraws at
60 fps instead of rescanning 26 million samples per frame.

**Export** — MP3 at 128/192/256/320 kbps (encoded in a Web Worker so the UI stays
live) or WAV at 16-bit, 24-bit or 32-bit float. Export the whole track or just
the selection, then hand it to the iOS share sheet, download it, or turn it into
a link.

## Built for the phone

- One-finger drag selects, one-finger tap moves the playhead, two-finger pinch
  zooms and two-finger drag pans — the gesture set phone audio apps already use.
- Selection edges have a 22 px grab zone, and every control is at least a 44 pt
  tap target. An end-to-end test asserts this so it cannot regress.
- `viewport-fit=cover` plus safe-area insets: the header clears the Dynamic
  Island and the transport clears the home indicator.
- Declares a `playback` audio session, so the editor stays audible with the
  ring/silent switch on.
- Add to Home Screen runs it standalone, and a service worker caches the app
  shell so it opens with no signal.
- When the page goes to the background it snapshots the current buffer to
  IndexedDB, so a tab that iOS discards mid-edit comes back where you left it.
- 43 KB of JavaScript for the editor (14 KB gzipped); the 165 KB MP3 encoder is
  only fetched when you actually export an MP3.

## Getting started

```bash
npm install
npm run dev          # http://localhost:5173
```

To exercise the Worker routes as well, build first and run Wrangler:

```bash
npm run build
npm run cf:dev
```

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run typecheck` | Typechecks the app, the Worker and the tooling |
| `npm test` | Unit tests (DSP, WAV, peaks, history, Worker) |
| `npm run test:e2e` | Playwright suite in Chromium at iPhone 14 Pro Max size |
| `npm run icons` | Regenerates `public/icons` from `scripts/generate-icons.mjs` |
| `npm run deploy` | Builds and deploys with Wrangler |

## Deploying to Cloudflare

Pushes to `main` deploy through `.github/workflows/deploy.yml`, which needs two
repository secrets:

| Secret | Where it comes from |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An API token with the **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Account ID |

To deploy by hand instead:

```bash
npx wrangler login
npm run deploy
```

The Worker is configured with
[static assets](https://developers.cloudflare.com/workers/static-assets/) and
`run_worker_first = ["/api/*", "/s/*"]`, so page loads and JS/CSS requests are
served straight from Cloudflare's edge and never invoke the Worker. Caching and
security headers come from `public/_headers`.

### Optional: share links

Everything works with no bindings at all. If you also want the **Create link**
button — which uploads one exported clip and returns a short URL — create a
bucket and uncomment the `[[r2_buckets]]` block in `wrangler.toml`:

```bash
npx wrangler r2 bucket create music-editor-shares
```

Then add a lifecycle rule so shared clips are deleted after they expire; the
Worker stores an `expiresAt` and refuses to serve stale objects, but R2's own
rule is what actually reclaims the storage. Adjust the window with the
`SHARE_TTL_SECONDS` and `SHARE_MAX_BYTES` vars in `wrangler.toml`.

Without the binding, `/api/share` returns 501 and the button stays hidden.

## How it fits together

```
index.html            markup for the whole UI; the app queries it, never builds it
src/main.ts           entry point and service worker registration
src/editor.ts         the document: audio, selection, viewport, history, transport
src/ui/app.ts         binds DOM controls to editor commands
src/ui/waveform.ts    canvas rendering and every touch gesture
src/audio/pcm.ts      the in-memory audio type and helpers
src/audio/dsp.ts      every destructive edit, as pure functions
src/audio/wav.ts      WAV writing, and reading for formats Safari refuses
src/audio/peaks.ts    the min/max/RMS pyramid the waveform draws from
src/audio/engine.ts   playback, and the iOS audio-session handling
src/audio/export.ts   WAV writing and MP3 worker orchestration
src/audio/offline.ts  edits that use OfflineAudioContext (speed, resampling)
src/workers/          the MP3 encoder worker
src/storage/session.ts IndexedDB snapshot for tab-eviction recovery
worker/index.ts       the Cloudflare Worker
```

The editing core is deliberately plain data: a `Pcm` is a sample rate and one
`Float32Array` per channel, and every edit is a pure function from `Pcm` to
`Pcm`. That is what makes undo a matter of keeping the previous reference, and
what lets the whole edit surface be tested in Node with no browser involved.

Samples are left unclamped between edits, so a boost followed by a normalise
recovers cleanly instead of baking in clipping; the waveform flags anything over
full scale, and clamping happens once, at export.

## Testing

```bash
npm test          # 79 unit tests
npm run test:e2e  # 14 end-to-end tests in a real browser
```

The end-to-end suite drives the built app in Chromium at 430 × 932 with touch
input and a 3× device pixel ratio. It opens a generated WAV, drags a selection
across the canvas, trims and undoes, cuts and pastes, plays, exports both a real
WAV and a real MP3, and checks the bytes that come back.

Point it at the real Worker — CSP headers and all — with:

```bash
npm run build && npm run cf:dev          # in one terminal
E2E_BASE_URL=http://127.0.0.1:8787 npm run test:e2e
```

## Known limits

- Undo history is capped by both entry count and total bytes (512 MB by
  default), because a five-minute stereo buffer is roughly 115 MB and iOS will
  kill a tab that grows too far. The oldest states are dropped first.
- Session snapshots are skipped above ~64 MB; past that, writing during
  `pagehide` is slower than the eviction it is meant to survive.
- Speed change moves pitch with it, like tape. There is no time-stretch.
- MP3 encoding is pure JavaScript (LAME), so it is roughly real-time-ish on a
  phone. Progress is reported while it runs.

## Licence

MIT — see [LICENSE](LICENSE).
