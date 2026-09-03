import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  daysCoveredForReadings,
  estimateDaysUntilWatering,
  hoursUntilDayEnd,
  warmupHoursRemaining,
} from './plantAdvice.js';

describe('daysCoveredForReadings', () => {
  it('returns 0 for no readings', () => {
    assert.equal(daysCoveredForReadings([]), 0);
  });

  it('returns days since the oldest reading, not the newest', () => {
    const now = Date.now();
    const readings = [
      { timestamp: new Date(now - 5 * 24 * 3600_000) },
      { timestamp: new Date(now - 1 * 24 * 3600_000) },
    ];
    const days = daysCoveredForReadings(readings);
    assert.ok(days > 4.9 && days < 5.1, `expected ~5 days, got ${days}`);
  });
});

describe('warmupHoursRemaining', () => {
  it('is 0 once daysCovered meets warmupMinDays', () => {
    assert.equal(warmupHoursRemaining(3, 3), 0);
    assert.equal(warmupHoursRemaining(10, 3), 0);
  });

  it('returns the exact remaining hours before that', () => {
    assert.equal(warmupHoursRemaining(1, 3), 48);
    assert.equal(warmupHoursRemaining(2.5, 3), 12);
  });
});

describe('hoursUntilDayEnd', () => {
  it('returns close to 24 just after local midnight', () => {
    const justAfterMidnightUtc = new Date('2026-01-01T00:00:30Z');
    const hours = hoursUntilDayEnd(justAfterMidnightUtc, 'UTC');
    assert.ok(hours > 23.9 && hours <= 24, `expected ~24h, got ${hours}`);
  });

  it('returns close to 0 just before local midnight', () => {
    const justBeforeMidnightUtc = new Date('2026-01-01T23:59:30Z');
    const hours = hoursUntilDayEnd(justBeforeMidnightUtc, 'UTC');
    assert.ok(hours >= 0 && hours < 0.1, `expected ~0h, got ${hours}`);
  });

  it('respects a non-UTC timezone', () => {
    // 22:30 UTC = 23:30 in Europe/Paris (UTC+1 in January) — 30 minutes left in the Paris day.
    const date = new Date('2026-01-01T22:30:00Z');
    const hours = hoursUntilDayEnd(date, 'Europe/Paris');
    assert.ok(hours > 0.4 && hours < 0.6, `expected ~0.5h, got ${hours}`);
  });
});

describe('estimateDaysUntilWatering', () => {
  it('returns null with fewer than 2 points in the window', () => {
    assert.equal(estimateDaysUntilWatering([{ timestamp: new Date(), soilMoisturePercent: 40 }], 20), null);
  });

  it('returns null when moisture is not decreasing', () => {
    const now = Date.now();
    const readings = [
      { timestamp: new Date(now - 4 * 24 * 3600_000), soilMoisturePercent: 30 },
      { timestamp: new Date(now - 2 * 24 * 3600_000), soilMoisturePercent: 32 },
      { timestamp: new Date(now), soilMoisturePercent: 35 },
    ];
    assert.equal(estimateDaysUntilWatering(readings, 20), null);
  });

  it('projects a plausible number of days for a clean linear decline', () => {
    // Drops 2%/day; currently at 40%, threshold 20% → ~10 days away.
    const now = Date.now();
    const readings = [
      { timestamp: new Date(now - 4 * 24 * 3600_000), soilMoisturePercent: 48 },
      { timestamp: new Date(now - 3 * 24 * 3600_000), soilMoisturePercent: 46 },
      { timestamp: new Date(now - 2 * 24 * 3600_000), soilMoisturePercent: 44 },
      { timestamp: new Date(now - 1 * 24 * 3600_000), soilMoisturePercent: 42 },
      { timestamp: new Date(now), soilMoisturePercent: 40 },
    ];
    const days = estimateDaysUntilWatering(readings, 20);
    assert.ok(days != null && days > 8 && days < 12, `expected ~10 days, got ${days}`);
  });

  it('ignores readings outside the prediction window', () => {
    const now = Date.now();
    const readings = [
      { timestamp: new Date(now - 30 * 24 * 3600_000), soilMoisturePercent: 90 }, // way outside the 5-day window
      { timestamp: new Date(now - 1 * 24 * 3600_000), soilMoisturePercent: 40 },
      { timestamp: new Date(now), soilMoisturePercent: 38 },
    ];
    // Only the last 2 points (both inside the window) should drive the slope — a real decline.
    const days = estimateDaysUntilWatering(readings, 20);
    assert.ok(days != null, 'expected a prediction from the 2 in-window points alone');
  });
});
