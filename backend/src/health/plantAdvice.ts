import type { Reading } from '@prisma/client';

// Window used for the linear-regression watering-date prediction (spec section 7) — deliberately
// short: a device's drying rate can change quickly (weather, a recent watering), a longer window
// would smooth over exactly the recent behavior this prediction needs to reflect.
export const WATERING_PREDICTION_WINDOW_DAYS = 5;
// Sanity cap — an almost-flat but still-technically-negative slope can otherwise project an
// absurd number of days; nothing genuinely useful to say past this, and Parrot's own UI never
// shows a number this large either.
export const MAX_WATERING_PREDICTION_DAYS = 60;

// Mirrors health/scoring.ts's own `daysCovered` computation (oldest reading vs. now) — deliberately
// duplicated rather than imported: this module must stay independent of computeDeviceHealth's
// internals (only its OUTPUT, DeviceHealth, is a dependency — see plantAdvice.ts's buildPlantAdvice).
export function daysCoveredForReadings(readings: Array<{ timestamp: Date }>): number {
  if (readings.length === 0) return 0;
  const oldest = readings.reduce((min, r) => (r.timestamp < min ? r.timestamp : min), readings[0].timestamp);
  return (Date.now() - oldest.getTime()) / (24 * 3600_000);
}

// Hours left before the device-wide warmup gate (HealthSettings.warmupMinDays) clears — the {time}
// placeholder in Parrot's temperature_soon_available_timed/light_soon_available_title_timed strings.
export function warmupHoursRemaining(daysCovered: number, warmupMinDays: number): number {
  return Math.max(0, (warmupMinDays - daysCovered) * 24);
}

// Hours remaining until the current calendar day (in `timezone`) ends — used for the light card's
// own "soon_available" reason when the global warmup has already cleared but Part H's separate
// zero-complete-days gate hasn't (see health/dailyLightIntegral.ts, the same computation style).
export function hoursUntilDayEnd(now: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const secondsSinceMidnight = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return (24 * 3600 - secondsSinceMidnight) / 3600;
}

// Simple least-squares linear regression over the last WATERING_PREDICTION_WINDOW_DAYS days of soil
// moisture, projecting when the value will cross `minPercent` — the {x} placeholder in
// sensorInfo_description_soilMoisture_range. Returns null whenever there's nothing reliable to say:
// fewer than 2 points in the window, a flat/rising trend, or a non-finite/non-positive projection.
export function estimateDaysUntilWatering(
  readings: Array<{ timestamp: Date; soilMoisturePercent: number | null }>,
  minPercent: number,
): number | null {
  const cutoff = Date.now() - WATERING_PREDICTION_WINDOW_DAYS * 24 * 3600_000;
  const points = readings
    .filter((r): r is { timestamp: Date; soilMoisturePercent: number } => r.soilMoisturePercent != null && r.timestamp.getTime() >= cutoff)
    .map((r) => ({ x: (r.timestamp.getTime() - cutoff) / (24 * 3600_000), y: r.soilMoisturePercent }));
  if (points.length < 2) return null;

  const n = points.length;
  const sumX = points.reduce((sum, p) => sum + p.x, 0);
  const sumY = points.reduce((sum, p) => sum + p.y, 0);
  const sumXY = points.reduce((sum, p) => sum + p.x * p.y, 0);
  const sumXX = points.reduce((sum, p) => sum + p.x * p.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;
  const slopePerDay = (n * sumXY - sumX * sumY) / denominator; // %/day, negative = drying
  if (slopePerDay >= 0) return null;

  const latestValue = points[points.length - 1].y;
  const days = (latestValue - minPercent) / -slopePerDay;
  if (!Number.isFinite(days) || days <= 0) return null;
  return Math.min(Math.round(days), MAX_WATERING_PREDICTION_DAYS);
}
