import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Sandboxes and CI images sometimes ship Chromium at a fixed path instead of
// letting Playwright manage its own download. Use it when it is there.
const PREINSTALLED_CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const executablePath = existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;

/**
 * The end-to-end suite drives the built app in Chromium at iPhone 14 Pro Max
 * dimensions, with touch input, so the gesture and layout work is exercised the
 * way it will be used rather than with a mouse on a desktop viewport.
 */
// Point at an already-running server (for example `npm run cf:dev`, which
// serves through the real Worker with the `_headers` CSP applied) instead of
// the built-in preview server.
const externalBaseURL = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'line' : 'list',
  timeout: 60_000,

  use: {
    baseURL: externalBaseURL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'iphone-14-pro-max',
      use: {
        ...devices['Desktop Chrome'],
        // iPhone 14 Pro Max: 430 × 932 points at 3× with touch input.
        viewport: { width: 430, height: 932 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        launchOptions: {
          // Headless Chromium has no audio device; this keeps the transport
          // usable so playback can actually be asserted.
          args: ['--autoplay-policy=no-user-gesture-required'],
          ...(executablePath ? { executablePath } : {}),
        },
      },
    },
  ],

  ...(externalBaseURL
    ? {}
    : {
        webServer: {
          command: 'npm run build && npx vite preview --port 4173 --host 127.0.0.1',
          url: 'http://127.0.0.1:4173',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
