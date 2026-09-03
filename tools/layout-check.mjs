import { devices, chromium } from '@playwright/test';
import { ensureFixture } from './fixture.mjs';

const BASE = process.env.BASE ?? BASE;
const FILE = ensureFixture(process.env.AUDIO);

const profiles = [
  { name: '320 (SE1 / display-zoom)', width: 320, height: 568 },
  { name: '360 (Android common)', width: 360, height: 740 },
  { name: '375 (iPhone SE3)', width: 375, height: 667 },
  { name: '390 (iPhone 14)', width: 390, height: 844 },
  { name: '393 (iPhone 14 Pro)', width: 393, height: 852 },
  { name: '430 (15 Pro Max)', width: 430, height: 932 },
  { name: '852x393 landscape', width: 852, height: 393 },
];

const browser = await chromium.launch();
for (const p of profiles) {
  const context = await browser.newContext({
    viewport: { width: p.width, height: p.height },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: devices['iPhone 14 Pro'].userAgent,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'load' });
  await page.setInputFiles('#file-input', FILE);
  await page.waitForSelector('.transport .button--play:not([disabled])', { timeout: 15000 });
  await page.waitForTimeout(250);

  const r = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const offscreen = [];
    // Everything outside the intentionally side-scrolling toolbar must fit.
    for (const el of document.querySelectorAll('.topbar *, .readout *, .transport *, .bottombar *')) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      if (b.right > vw + 0.5 || b.left < -0.5 || b.bottom > vh + 0.5) {
        offscreen.push(el.className || el.tagName);
      }
    }
    const truncated = [...document.querySelectorAll('.readout__label')]
      .filter((el) => el.scrollWidth > el.clientWidth + 0.5)
      .map((el) => el.textContent);
    const taps = [...document.querySelectorAll('.transport .button, .topbar .button, .bottombar .button')]
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.width > 0);
    return {
      appW: +document.querySelector('.app').getBoundingClientRect().width.toFixed(1),
      col: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
      docScrollW: document.documentElement.scrollWidth,
      offscreen,
      truncated,
      minTap: +Math.min(...taps.map((b) => Math.min(b.width, b.height))).toFixed(1),
      exportBottom: +document.querySelector('.bottombar .button').getBoundingClientRect().bottom.toFixed(1),
      vh,
      canvasPx: (() => {
        const c = document.getElementById('waveform');
        return c.width * c.height;
      })(),
    };
  });

  console.log(`${p.name.padEnd(24)} app=${r.appW} col=${r.col} docScrollW=${r.docScrollW} offscreen=${r.offscreen.length} truncatedLabels=${r.truncated.length} minTap=${r.minTap} export=${r.exportBottom}<=${r.vh} canvasMpx=${(r.canvasPx / 1e6).toFixed(2)} jsErrors=${errors.length}`);
  if (r.offscreen.length) console.log('   offscreen:', r.offscreen.join(', '));
  if (errors.length) console.log('   errors:', errors.join(' | '));
  await context.close();
}
await browser.close();
