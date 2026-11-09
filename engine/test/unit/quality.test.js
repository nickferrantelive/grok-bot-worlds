import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoQualityName, createFrameMeter, PRESETS } from '../../quality.js';

test('phone preset drops shadows and post, desktop keeps them', () => {
  assert.equal(PRESETS.phone.shadows, false);
  assert.equal(PRESETS.phone.post, false);
  assert.equal(PRESETS.desktop.shadows, true);
  assert.equal(PRESETS.desktop.post, true);
});

test('auto pick', () => {
  assert.equal(autoQualityName({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), 'desktop');
  assert.equal(autoQualityName({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' }), 'phone');
  assert.equal(autoQualityName({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel) Mobile' }), 'phone');
  assert.equal(autoQualityName({ userAgent: 'x', coarsePointer: true, minScreen: 800 }), 'phone');
  assert.equal(autoQualityName({ userAgent: 'x', coarsePointer: true, minScreen: 1200 }), 'desktop', 'a touch laptop is not a phone');
  assert.equal(autoQualityName({ userAgent: 'x', software: true }), 'phone', 'software rendering cannot carry the desktop preset');
});

test('the meter measures, and an auto pick that cannot keep up lowers its pixel ratio', () => {
  const applied = [];
  let changes = 0;
  const quality = { pixelRatio: 2 };
  const meter = createFrameMeter({ renderer: { setPixelRatio: (r) => applied.push(r) }, quality, canAdapt: true, onResolutionChange: () => { changes += 1; } });
  for (let i = 0; i < 60; i += 1) meter.tick(1 / 60);
  assert.ok(Math.abs(meter.fps - 60) < 1);
  assert.equal(globalThis.__fps, meter.fps);
  assert.equal(applied.length, 0, 'fast enough, leave it alone');
  for (let i = 0; i < 400; i += 1) meter.tick(1 / 15);
  assert.ok(applied.length >= 1);
  assert.equal(applied[0], 1.75);
  assert.ok(quality.pixelRatio >= 1);
  assert.equal(changes, applied.length);
});

test('a URL override cannot be adapted away', () => {
  const applied = [];
  const quality = { pixelRatio: 2 };
  const meter = createFrameMeter({ renderer: { setPixelRatio: (r) => applied.push(r) }, quality, canAdapt: false });
  for (let i = 0; i < 400; i += 1) meter.tick(1 / 10);
  assert.equal(applied.length, 0);
});
