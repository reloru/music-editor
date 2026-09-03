import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '../src/audio/wav';
import { createPcm } from '../src/audio/pcm';

/** Writes a real WAV to disk for the file picker to pick up. */
function writeFixture(name: string, channels = 2, seconds = 3, sampleRate = 44100): string {
  const frames = seconds * sampleRate;
  const pcm = createPcm(channels, frames, sampleRate);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    pcm.channels[0][i] = Math.sin(2 * Math.PI * 440 * t) * 0.6;
    if (channels > 1) pcm.channels[1][i] = Math.sin(2 * Math.PI * 660 * t) * 0.3;
  }
  const path = join(mkdtempSync(join(tmpdir(), 'editor-')), name);
  writeFileSync(path, Buffer.from(encodeWav(pcm, 16)));
  return path;
}

const FIXTURE = writeFixture('fixture.wav');
const MONO_FIXTURE = writeFixture('mono.wav', 1);

async function openFixture(page: Page, file = FIXTURE): Promise<void> {
  await page.goto('/');
  await page.setInputFiles('#file-input', file);
  await expect(page.locator('#app')).toHaveAttribute('data-empty', 'false');
  await expect(page.locator('#busy')).toBeHidden();
}

/**
 * Picks a radio option the way a finger does: by tapping its label, since the
 * input itself is visually hidden behind the styled span.
 */
async function selectOption(page: Page, fieldset: string, label: string): Promise<void> {
  await page.locator(`${fieldset} label`).filter({ hasText: label }).click();
}

/** Drags across the waveform to select roughly the middle third. */
async function selectMiddle(page: Page): Promise<void> {
  const canvas = page.locator('#waveform');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('waveform has no layout box');

  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.33, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.66, y, { steps: 8 });
  await page.mouse.up();
}

test.describe('editor', () => {
  test('shows the empty state before a file is opened', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('#app')).toHaveAttribute('data-empty', 'true');
  });

  test('opens a WAV and reports its properties', async ({ page }) => {
    await openFixture(page);

    await expect(page.locator('#track-name')).toHaveText('fixture.wav');
    await expect(page.locator('#track-meta')).toContainText('Stereo');
    await expect(page.locator('#readout-duration')).toHaveText('0:03.00');
    await expect(page.locator('#empty-state')).toBeHidden();
  });

  test('fits the iPhone viewport without page scrolling', async ({ page }) => {
    await openFixture(page);

    const overflow = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth > window.innerWidth,
      vertical: document.documentElement.scrollHeight > window.innerHeight + 1,
    }));
    expect(overflow.horizontal).toBe(false);
    expect(overflow.vertical).toBe(false);
  });

  test('keeps every control at a thumb-sized tap target', async ({ page }) => {
    await openFixture(page);

    const controls = page.locator('.tool, .transport .button, .bottombar .button');
    const count = await controls.count();
    expect(count).toBeGreaterThan(10);

    for (let i = 0; i < count; i++) {
      const box = await controls.nth(i).boundingBox();
      expect(box, `control ${i} has no box`).not.toBeNull();
      // Apple's minimum recommended target is 44 × 44 points.
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
  });

  test('drag selects a range and enables the range-only tools', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('[data-command="trim"]')).toBeDisabled();

    await expect(page.locator('#readout-selection-start')).toHaveValue('');

    await selectMiddle(page);

    await expect(page.locator('#readout-selection-start')).not.toHaveValue('');
    await expect(page.locator('#readout-selection-end')).not.toHaveValue('');
    await expect(page.locator('[data-command="trim"]')).toBeEnabled();
    await expect(page.locator('[data-command="cut"]')).toBeEnabled();
  });

  test('types a selection into the readout fields', async ({ page }) => {
    await openFixture(page);
    await expect(page.locator('[data-command="trim"]')).toBeDisabled();

    await page.locator('#readout-selection-start').fill('0:01.00');
    await page.locator('#readout-selection-start').press('Enter');
    await page.locator('#readout-selection-end').fill('2.5');
    await page.locator('#readout-selection-end').press('Enter');

    // Bare seconds come back formatted, and the range reaches the tools.
    await expect(page.locator('#readout-selection-end')).toHaveValue('0:02.50');
    await expect(page.locator('[data-command="trim"]')).toBeEnabled();

    await page.locator('[data-command="trim"]').click();
    await expect(page.locator('#readout-duration')).toHaveText('0:01.50');
  });

  test('types a playhead position into the readout', async ({ page }) => {
    await openFixture(page);

    await page.locator('#readout-playhead').fill('1:02.25');
    await page.locator('#readout-playhead').press('Enter');
    // Past the end of a 3 s track it clamps rather than being refused.
    await expect(page.locator('#readout-playhead')).toHaveValue('0:03.00');

    await page.locator('#readout-playhead').fill('0:01.50');
    await page.locator('#readout-playhead').press('Enter');
    await expect(page.locator('#readout-playhead')).toHaveValue('0:01.50');
  });

  test('rejects an unreadable time instead of moving the playhead', async ({ page }) => {
    await openFixture(page);

    await page.locator('#readout-playhead').fill('half past four');
    await page.locator('#readout-playhead').press('Enter');

    await expect(page.locator('#toast')).toHaveAttribute('data-kind', 'error');
    await expect(page.locator('#readout-playhead')).toHaveValue('0:00.00');
  });

  test('trims to the selection and undoes back to the original length', async ({ page }) => {
    await openFixture(page);
    await selectMiddle(page);
    await page.locator('[data-command="trim"]').click();

    await expect(page.locator('#readout-duration')).not.toHaveText('0:03.00');
    await expect(page.locator('#undo')).toBeEnabled();

    await page.locator('#undo').click();
    await expect(page.locator('#readout-duration')).toHaveText('0:03.00');
    await expect(page.locator('#redo')).toBeEnabled();
  });

  test('cut then paste restores the original duration', async ({ page }) => {
    await openFixture(page);
    await selectMiddle(page);

    await page.locator('[data-command="cut"]').click();
    await expect(page.locator('#readout-duration')).not.toHaveText('0:03.00');

    await page.locator('[data-command="paste"]').click();
    await expect(page.locator('#readout-duration')).toHaveText('0:03.00');
  });

  test('select all then delete is refused rather than emptying the track', async ({ page }) => {
    await openFixture(page);
    await page.locator('[data-command="select-all"]').click();
    await page.locator('[data-command="delete"]').click();

    await expect(page.locator('#toast')).toContainText('empty track');
    await expect(page.locator('#readout-duration')).toHaveText('0:03.00');
  });

  test('plays and pauses through the transport', async ({ page }) => {
    await openFixture(page);
    const play = page.locator('[data-action="play"]');

    await play.click();
    await expect(play).toHaveAttribute('aria-label', 'Pause');
    await expect
      .poll(async () => page.locator('#readout-playhead').textContent())
      .not.toBe('0:00.00');

    await play.click();
    await expect(play).toHaveAttribute('aria-label', 'Play');
  });

  test('exports a WAV file', async ({ page }) => {
    await openFixture(page);
    await page.locator('[data-command="export"]').click();
    await selectOption(page, '#export-format', 'WAV');

    const download = page.waitForEvent('download');
    await page.locator('#export-download').click();
    const file = await download;

    expect(file.suggestedFilename()).toBe('fixture-edit.wav');
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);

    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
    // 3 s of 44.1 kHz 16-bit stereo, plus the 44-byte header.
    expect(bytes.length).toBe(44 + 3 * 44100 * 2 * 2);
  });

  test('exports an MP3 through the encoder worker', async ({ page }) => {
    await openFixture(page);
    await page.locator('[data-command="export"]').click();
    await selectOption(page, '#export-format', 'MP3');
    await selectOption(page, '#export-bitrate', '128k');

    const download = page.waitForEvent('download');
    await page.locator('#export-download').click();
    const file = await download;

    expect(file.suggestedFilename()).toBe('fixture-edit.mp3');
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);

    expect(bytes.length).toBeGreaterThan(1000);
    // Either an ID3 tag or a raw MPEG frame sync.
    const isId3 = bytes.subarray(0, 3).toString('ascii') === 'ID3';
    const isFrameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
    expect(isId3 || isFrameSync).toBe(true);
  });

  test('applies gain from the sheet', async ({ page }) => {
    await openFixture(page);
    await page.locator('[data-command="gain"]').click();
    await expect(page.locator('#gain-sheet')).toBeVisible();

    await page.locator('#gain-slider').fill('-6');
    await page.locator('#gain-sheet button[value="apply"]').click();

    await expect(page.locator('#gain-sheet')).toBeHidden();
    await expect(page.locator('#undo')).toBeEnabled();
    await expect(page.locator('#undo')).toHaveAttribute('title', /Gain/);
  });

  test('lists every effect and applies one to the track', async ({ page }) => {
    await openFixture(page);
    await page.locator('[data-command="effects"]').click();

    const rows = page.locator('#effects-list .effect-list__item');
    await expect(rows).toHaveCount(16);
    await expect(page.locator('#effects-scope')).toHaveText('Applies to the whole track.');

    await rows.filter({ hasText: 'Tremolo' }).click();
    await expect(page.locator('#effect-sheet')).toBeVisible();
    await expect(page.locator('#effect-title')).toHaveText('Tremolo');

    // Two sliders, from the registry — nothing about tremolo is in the markup.
    const sliders = page.locator('#effect-controls input[type="range"]');
    await expect(sliders).toHaveCount(2);
    await sliders.first().fill('9');
    await expect(page.locator('#effect-controls .effect-param__value').first()).toHaveText('9.0 Hz');

    await page.locator('#effect-sheet button[value="apply"]').click();
    await expect(page.locator('#effect-sheet')).toBeHidden();
    await expect(page.locator('#undo')).toBeEnabled();
    await expect(page.locator('#undo')).toHaveAttribute('title', 'Undo Tremolo');
  });

  test('builds segmented controls for choices and toggles', async ({ page }) => {
    await openFixture(page);
    await page.locator('[data-command="effects"]').click();
    await page.locator('.effect-list__item').filter({ hasText: 'Bit crusher' }).click();

    // acrusher has a two-option scale, a sweep toggle, and eight sliders.
    await expect(page.locator('#effect-controls .segmented')).toHaveCount(2);
    await expect(page.locator('#effect-controls input[type="range"]')).toHaveCount(9);

    await page.locator('#effect-controls .segmented label').filter({ hasText: 'Logarithmic' }).click();
    await page.locator('#effect-sheet button[value="apply"]').click();
    await expect(page.locator('#undo')).toHaveAttribute('title', 'Undo Bit crusher');
  });

  test('hides the controls a setting makes inert', async ({ page }) => {
    await openFixture(page);
    await page.locator('[data-command="effects"]').click();
    await page.locator('.effect-list__item').filter({ hasText: 'Chorus' }).click();

    const voices = page.locator('#effect-controls [data-param="voices"] input');
    await expect(page.locator('#effect-controls [data-param="delay2"]')).toBeVisible();
    await expect(page.locator('#effect-controls [data-param="delay3"]')).toBeHidden();

    await voices.fill('3');
    await expect(page.locator('#effect-controls [data-param="delay3"]')).toBeVisible();
    await voices.fill('1');
    await expect(page.locator('#effect-controls [data-param="delay2"]')).toBeHidden();

    await page.locator('#effect-sheet button[value="cancel"]').click();
    await page.locator('[data-command="effects"]').click();
    await page.locator('.effect-list__item').filter({ hasText: 'Bit crusher' }).click();

    // The sweep depth and rate only exist while the sweep is on.
    await expect(page.locator('#effect-controls [data-param="lfoRate"]')).toBeHidden();
    await page.locator('#effect-controls [data-param="lfo"] label').filter({ hasText: 'On' }).click();
    await expect(page.locator('#effect-controls [data-param="lfoRate"]')).toBeVisible();
  });

  test('keeps per-effect settings while the track is open', async ({ page }) => {
    await openFixture(page);

    await page.locator('[data-command="effects"]').click();
    await page.locator('.effect-list__item').filter({ hasText: 'Tremolo' }).click();
    await page.locator('#effect-controls input[type="range"]').first().fill('12');
    await page.locator('#effect-sheet button[value="cancel"]').click();

    await page.locator('[data-command="effects"]').click();
    await page.locator('.effect-list__item').filter({ hasText: 'Tremolo' }).click();
    await expect(page.locator('#effect-controls input[type="range"]').first()).toHaveValue('12');

    await page.locator('#effect-reset').click();
    await expect(page.locator('#effect-controls input[type="range"]').first()).toHaveValue('5');
  });

  test('disables the stereo-only effects on a mono track', async ({ page }) => {
    await openFixture(page, MONO_FIXTURE);
    await expect(page.locator('#track-meta')).toContainText('Mono');

    await page.locator('[data-command="effects"]').click();
    const haas = page.locator('.effect-list__item').filter({ hasText: 'Haas' });
    await expect(haas).toBeDisabled();
    await expect(haas).toContainText('Needs a stereo track.');
    await expect(page.locator('.effect-list__item').filter({ hasText: 'Tremolo' })).toBeEnabled();
  });

  test('applies an effect to the selection only', async ({ page }) => {
    await openFixture(page);
    await selectMiddle(page);

    await page.locator('[data-command="effects"]').click();
    await expect(page.locator('#effects-scope')).toHaveText('Applies to the selection.');
    await page.locator('.effect-list__item').filter({ hasText: 'Telephone' }).click();
    await page.locator('#effect-sheet button[value="apply"]').click();

    // The edit is recorded but the length is not, since no effect resamples.
    await expect(page.locator('#undo')).toHaveAttribute('title', 'Undo Telephone');
    await expect(page.locator('#readout-duration')).toHaveText('0:03.00');
  });

  test('previews an effect without changing the track', async ({ page }) => {
    await openFixture(page);
    await page.locator('[data-command="effects"]').click();
    await page.locator('.effect-list__item').filter({ hasText: 'Echo' }).click();

    const preview = page.locator('#effect-preview');
    await preview.click();
    await expect(preview).toHaveText('Stop preview');
    await preview.click();
    await expect(preview).toHaveText('Preview');

    // A preview is not an edit.
    await expect(page.locator('#undo')).toBeDisabled();
    await page.locator('#effect-sheet button[value="cancel"]').click();
    await expect(page.locator('#undo')).toBeDisabled();
  });

  test('runs a full edit and export without a console error', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(String(error)));

    await openFixture(page);
    await selectMiddle(page);
    await page.locator('[data-command="fade-in"]').click();
    await page.locator('[data-command="normalize"]').click();
    await page.locator('[data-command="trim"]').click();
    await page.locator('[data-action="play"]').click();
    await page.locator('[data-action="play"]').click();

    await page.locator('[data-command="export"]').click();
    const download = page.waitForEvent('download');
    await page.locator('#export-download').click();
    await download;

    // Catches Content-Security-Policy violations too, which only show up when
    // the app is served through the Worker with `_headers` applied.
    expect(problems).toEqual([]);
  });

  test('reports a file it cannot decode instead of failing silently', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', {
      name: 'broken.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('this is definitely not audio'),
    });

    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.locator('#toast')).toHaveAttribute('data-kind', 'error');
    await expect(page.locator('#app')).toHaveAttribute('data-empty', 'true');
  });
});
