import { chromium, devices } from '@playwright/test';
import { ensureFixture } from './fixture.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4321';
const FILE = ensureFixture(process.env.AUDIO);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: devices['iPhone 13'].userAgent,
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const THROTTLE = Number(process.env.THROTTLE ?? 6);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
await page.goto(BASE, { waitUntil: 'load' });
await page.setInputFiles('#file-input', FILE);
await page.waitForFunction(() => document.querySelector('#app').dataset.empty === 'false', null, { timeout: 20000 });
await page.waitForTimeout(400);

const result = await page.evaluate(async () => {
  const canvas = document.querySelector('#waveform');
  const rect = canvas.getBoundingClientRect();
  const y = rect.top + rect.height / 2;

  const fire = (type, x, id = 1, buttons = 1) =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        pointerId: id,
        pointerType: 'touch',
        isPrimary: true,
        clientX: x,
        clientY: y,
        buttons,
        bubbles: true,
        cancelable: true,
      }),
    );

  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

  // Warm up.
  fire('pointerdown', rect.left + 20);
  fire('pointermove', rect.left + 100);
  fire('pointerup', rect.left + 100, 1, 0);
  await raf();

  const STEPS = 120;
  const t0 = performance.now();
  fire('pointerdown', rect.left + 10);
  for (let i = 0; i < STEPS; i++) {
    fire('pointermove', rect.left + 10 + (i / STEPS) * (rect.width - 20));
    await raf();
  }
  fire('pointerup', rect.left + rect.width - 10, 1, 0);
  const elapsed = performance.now() - t0;

  return {
    dragSteps: STEPS,
    totalMs: +elapsed.toFixed(1),
    msPerFrame: +(elapsed / STEPS).toFixed(2),
    fps: +(1000 / (elapsed / STEPS)).toFixed(1),
    canvas: { w: canvas.width, h: canvas.height },
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
