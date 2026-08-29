import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWateringConfigEnableValues } from './wateringConfig.js';

test('buildWateringConfigEnableValues encodes percentages as ×10 raw integers', () => {
  const values = buildWateringConfigEnableValues(32, 38, 48);
  assert.deepEqual(values, { vwcIrrRaw: 320, vwcCmdRaw: 380, nIrr: 48 });
});

test('buildWateringConfigEnableValues rounds fractional percentages to the nearest ×10 integer', () => {
  const values = buildWateringConfigEnableValues(32.04, 37.96, 0);
  assert.deepEqual(values, { vwcIrrRaw: 320, vwcCmdRaw: 380, nIrr: 0 });
});

test('buildWateringConfigEnableValues passes nIrr through unchanged (already raw 15-minute units)', () => {
  const values = buildWateringConfigEnableValues(30, 40, 672);
  assert.equal(values.nIrr, 672);
});
