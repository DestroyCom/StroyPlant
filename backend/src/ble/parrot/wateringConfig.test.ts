import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeWateringConfigId,
  resolveWateringModeThresholds,
  type WateringConfigFields,
  type WateringModeCustomInputs,
  type WateringModePlantInputs,
} from './wateringConfig.js';

function fields(overrides: Partial<WateringConfigFields>): WateringConfigFields {
  return {
    plantId: 0,
    vwcIrrRaw: 0,
    vwcCmdRaw: 0,
    nIrr: 0,
    vwcIrrEcoRaw: 0,
    vwcCmdEcoRaw: 0,
    nIrrEco: 0,
    timeSlotStart: 0,
    timeSlotDuration: 0,
    vacationStart: 0,
    vacationEnd: 0,
    mode: 0,
    ...overrides,
  };
}

// Real vectors from the official Flower Power app's own config writes, captured via PacketLogger.
// The first 6 come from docs/ble-captures/{02_mode_perfect_drop,03_mode_plant_sitter,
// 04_mode_manuel,05_mode_custom,06_live_mode,13_full_flowerpower_app_workout}.pklg; the last 3
// from 15_full_sniff_30_aout_soir.pklg (sessions #8 and #31's two write batches). All 9 verified
// independently twice this session (once per re-analysis) with zero mismatches — see
// docs/superpowers/specs/2026-08-31-parrot-ble-full-capture-reanalysis.md.
const REAL_VECTORS: { name: string; fields: WateringConfigFields; expectedConfigId: number }[] = [
  {
    name: 'perfect_drop (02_mode_perfect_drop.pklg)',
    fields: fields({ plantId: 0x024b, vwcIrrRaw: 0x0140, vwcCmdRaw: 0x017c, timeSlotDuration: 0x05a0, mode: 0x01 }),
    expectedConfigId: 0x07d6,
  },
  {
    name: 'plant_sitter (03_mode_plant_sitter.pklg)',
    fields: fields({ plantId: 0x024b, vwcIrrRaw: 0x0104, vwcCmdRaw: 0x0140, timeSlotDuration: 0x05a0, mode: 0x01 }),
    expectedConfigId: 0x07ae,
  },
  {
    name: 'manuel (04_mode_manuel.pklg) — same thresholds as plant_sitter, mode off',
    fields: fields({ plantId: 0x024b, vwcIrrRaw: 0x0104, vwcCmdRaw: 0x0140, timeSlotDuration: 0x05a0, mode: 0x00 }),
    expectedConfigId: 0x07af,
  },
  {
    name: 'custom (05_mode_custom.pklg) — user-edited thresholds + 12h delay',
    fields: fields({ plantId: 0x024b, vwcIrrRaw: 0x012c, vwcCmdRaw: 0x0190, nIrr: 0x0030, timeSlotDuration: 0x05a0, mode: 0x01 }),
    expectedConfigId: 0x0766,
  },
  {
    name: 'live (06_live_mode.pklg)',
    fields: fields({ plantId: 0x024b, vwcIrrRaw: 0x0140, vwcCmdRaw: 0x017c, timeSlotDuration: 0x05a0, mode: 0x01 }),
    expectedConfigId: 0x07d6,
  },
  {
    name: 'workout, second pot (13_full_flowerpower_app_workout.pklg)',
    fields: fields({ vwcIrrRaw: 0x0140, vwcCmdRaw: 0x017c, timeSlotDuration: 0x05a0, mode: 0x01 }),
    expectedConfigId: 0x059d,
  },
  {
    name: '15_full_sniff session #8 (pot 8733, Perfect-Drop-like values)',
    fields: fields({ vwcIrrRaw: 0x0140, vwcCmdRaw: 0x017c, timeSlotDuration: 0x05a0, mode: 0x01 }),
    expectedConfigId: 0x059d,
  },
  {
    name: '15_full_sniff session #31 batch 1 (pot 8733, factory-default-like values)',
    fields: fields({ vwcIrrRaw: 0x017c, vwcCmdRaw: 0x01b8, timeSlotDuration: 0x05a0, mode: 0x01 }),
    expectedConfigId: 0x0565,
  },
  {
    name: '15_full_sniff session #31 batch 2 (pot 8733, Plant-Sitter-like values, mode off)',
    fields: fields({ plantId: 0x042f, vwcIrrRaw: 0x0104, vwcCmdRaw: 0x0140, nIrr: 0x0180, timeSlotDuration: 0x05a0, mode: 0x00 }),
    expectedConfigId: 0x004b,
  },
];

for (const vector of REAL_VECTORS) {
  test(`computeWateringConfigId matches the real device's own CONFIG_ID — ${vector.name}`, () => {
    assert.equal(computeWateringConfigId(vector.fields), vector.expectedConfigId);
  });
}

test('computeWateringConfigId folds a 32-bit vacation field into its low/high 16-bit halves', () => {
  const withoutVacation = computeWateringConfigId(fields({}));
  const withVacation = computeWateringConfigId(fields({ vacationStart: 0x01020304 }));
  // Low half (0x0304) and high half (0x0102) each contribute independently — not equal to XORing
  // the raw 32-bit value truncated to 16 bits, and not a no-op.
  assert.notEqual(withVacation, withoutVacation);
  assert.notEqual(withVacation, withoutVacation ^ 0x0304);
});

function plantInputs(overrides: Partial<WateringModePlantInputs>): WateringModePlantInputs {
  return {
    soilMoistureIrrigatePercent: null,
    soilMoistureCommandPercent: null,
    soilMoistureIrrigateEcoPercent: null,
    soilMoistureCommandEcoPercent: null,
    irrigateCalibrationSampleCount: null,
    irrigateEcoCalibrationSampleCount: null,
    ...overrides,
  };
}

const NO_CUSTOM: WateringModeCustomInputs = { vwcIrrPercent: null, vwcCmdPercent: null, nIrrDays: null };

test('PERFECT_DROP uses the species classic thresholds', () => {
  const plant = plantInputs({ soilMoistureIrrigatePercent: 32, soilMoistureCommandPercent: 38, irrigateCalibrationSampleCount: 384 });
  const result = resolveWateringModeThresholds('PERFECT_DROP', plant, NO_CUSTOM);
  assert.deepEqual(result, { eligible: true, mode: 1, vwcIrrPercent: 32, vwcCmdPercent: 38, nIrr: 384 });
});

test('PERFECT_DROP is ineligible with no plant profile', () => {
  assert.deepEqual(resolveWateringModeThresholds('PERFECT_DROP', null, NO_CUSTOM), { eligible: false });
});

test('PERFECT_DROP is ineligible when the species has no classic thresholds (WatchFlower-only species)', () => {
  const plant = plantInputs({});
  assert.deepEqual(resolveWateringModeThresholds('PERFECT_DROP', plant, NO_CUSTOM), { eligible: false });
});

test('PERFECT_DROP defaults a missing irrigateCalibrationSampleCount to 0', () => {
  const plant = plantInputs({ soilMoistureIrrigatePercent: 32, soilMoistureCommandPercent: 38 });
  const result = resolveWateringModeThresholds('PERFECT_DROP', plant, NO_CUSTOM);
  assert.deepEqual(result, { eligible: true, mode: 1, vwcIrrPercent: 32, vwcCmdPercent: 38, nIrr: 0 });
});

test('PLANT_SITTER uses the species eco thresholds when present', () => {
  const plant = plantInputs({
    soilMoistureIrrigatePercent: 32,
    soilMoistureCommandPercent: 38,
    soilMoistureIrrigateEcoPercent: 26,
    soilMoistureCommandEcoPercent: 32,
    irrigateEcoCalibrationSampleCount: 672,
  });
  const result = resolveWateringModeThresholds('PLANT_SITTER', plant, NO_CUSTOM);
  assert.deepEqual(result, { eligible: true, mode: 1, vwcIrrPercent: 26, vwcCmdPercent: 32, nIrr: 672 });
});

test('PLANT_SITTER falls back to classic-threshold-minus-6-points when eco data is missing', () => {
  const plant = plantInputs({ soilMoistureIrrigatePercent: 32, soilMoistureCommandPercent: 38, irrigateCalibrationSampleCount: 384 });
  const result = resolveWateringModeThresholds('PLANT_SITTER', plant, NO_CUSTOM);
  assert.deepEqual(result, { eligible: true, mode: 1, vwcIrrPercent: 26, vwcCmdPercent: 38, nIrr: 384 });
});

test('PLANT_SITTER is ineligible with no plant profile', () => {
  assert.deepEqual(resolveWateringModeThresholds('PLANT_SITTER', null, NO_CUSTOM), { eligible: false });
});

test('PLANT_SITTER is ineligible when neither eco nor classic thresholds exist', () => {
  assert.deepEqual(resolveWateringModeThresholds('PLANT_SITTER', plantInputs({}), NO_CUSTOM), { eligible: false });
});

test('MANUAL is always eligible with no species and provides no threshold overrides', () => {
  assert.deepEqual(resolveWateringModeThresholds('MANUAL', null, NO_CUSTOM), { eligible: true, mode: 0 });
});

test('MANUAL is eligible even with a full plant profile — thresholds still not overridden', () => {
  const plant = plantInputs({ soilMoistureIrrigatePercent: 32, soilMoistureCommandPercent: 38 });
  assert.deepEqual(resolveWateringModeThresholds('MANUAL', plant, NO_CUSTOM), { eligible: true, mode: 0 });
});

test('CUSTOM uses the user-entered values, converting nIrrDays to 15-minute units', () => {
  const custom: WateringModeCustomInputs = { vwcIrrPercent: 30, vwcCmdPercent: 45, nIrrDays: 2 };
  const result = resolveWateringModeThresholds('CUSTOM', null, custom);
  assert.deepEqual(result, { eligible: true, mode: 1, vwcIrrPercent: 30, vwcCmdPercent: 45, nIrr: 192 });
});

test('CUSTOM is ineligible until all 3 values are entered', () => {
  assert.deepEqual(resolveWateringModeThresholds('CUSTOM', null, { vwcIrrPercent: 30, vwcCmdPercent: null, nIrrDays: 2 }), {
    eligible: false,
  });
  assert.deepEqual(resolveWateringModeThresholds('CUSTOM', null, { vwcIrrPercent: null, vwcCmdPercent: 45, nIrrDays: 2 }), {
    eligible: false,
  });
  assert.deepEqual(resolveWateringModeThresholds('CUSTOM', null, { vwcIrrPercent: 30, vwcCmdPercent: 45, nIrrDays: null }), {
    eligible: false,
  });
});
