import type { Reading } from '@prisma/client';

// Gap threshold (design spec Part H, step 3): a calendar day is only "complete and usable" if no
// gap between two consecutive readings within it exceeds this — otherwise the whole day is dropped
// (treated like missing data, never partially trusted). At the default 5-minute poll interval this
// tolerates a couple of missed cycles without over-rejecting; a real multi-hour BLE/device outage
// correctly excludes that day instead of silently producing a truncated, misleadingly-low total.
export const MAX_GAP_MS = 2 * 3600_000;

export interface DailyLightTotal {
  // Calendar date in the given timezone, "YYYY-MM-DD".
  date: string;
  // True accumulated light for that day, in mol/m² (same unit as the raw `luminosity` reading) —
  // NOT yet multiplied by scoring.ts's UNIT_CONVERSION (that happens at the call site, same as
  // every other raw value scoring.ts converts).
  totalMol: number;
}

type LightReading = Pick<Reading, 'timestamp' | 'luminosity'>;

// "YYYY-MM-DD" in the given IANA timezone — the en-CA locale is a standard trick for getting
// Intl.DateTimeFormat to produce ISO-ordered digits directly, no manual string reassembly needed.
function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Real per-device daily light integral (design spec Part H) — replaces treating the Parrot Pot's
// `39e1fa0b` characteristic as if it were already a true accumulated daily total. Real production
// data (2 real Parrot Pots, 5 days) showed it's actually an INSTANTANEOUS light-derived reading
// expressed in mol/m²/day-equivalent units: flat ~0.1 floor overnight, sharp solar-noon peak
// (~70 observed), back to floor by evening. Two consecutive instantaneous rate samples r1 at t1 and
// r2 at t2 (same units, mol/m²/day) integrate via the trapezoidal rule: the light received between
// them is the average rate times the elapsed FRACTION OF A DAY, `((r1+r2)/2) * ((t2-t1)/86_400_000)`
// — summing this across a whole calendar day's consecutive pairs gives that day's true total mol/m²
// received, which is what should actually be compared against a species' daily light threshold.
//
// Returns only fully "complete" days (see MAX_GAP_MS above), most-recent-first, and NEVER includes
// the current, still-in-progress calendar day (in `timezone`) — a day that hasn't ended yet cannot
// be a complete measurement by definition, no matter how dense its readings so far are. The partial
// interval before a day's first reading and after its last reading is not counted (edge trapezoids
// dropped) — both edges sit in the flat overnight floor in every real observation so far, so the
// error this introduces is negligible in practice.
export function computeDailyTotals(readings: LightReading[], timezone: string): DailyLightTotal[] {
  const points = readings
    .filter((reading): reading is LightReading & { luminosity: number } => reading.luminosity != null)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const byDay = new Map<string, Array<{ timestamp: Date; luminosity: number }>>();
  for (const point of points) {
    const key = dayKey(point.timestamp, timezone);
    const dayPoints = byDay.get(key);
    if (dayPoints) dayPoints.push(point);
    else byDay.set(key, [point]);
  }

  const todayKey = dayKey(new Date(), timezone);
  const totals: DailyLightTotal[] = [];

  for (const [date, dayPoints] of byDay) {
    if (date === todayKey) continue; // never a "complete" day — it hasn't ended yet
    if (dayPoints.length < 2) continue; // nothing to integrate between

    let totalMol = 0;
    let hasExcessiveGap = false;
    for (let i = 1; i < dayPoints.length; i++) {
      const prev = dayPoints[i - 1];
      const cur = dayPoints[i];
      const gapMs = cur.timestamp.getTime() - prev.timestamp.getTime();
      if (gapMs > MAX_GAP_MS) {
        hasExcessiveGap = true;
        break;
      }
      const elapsedDayFraction = gapMs / 86_400_000;
      totalMol += ((prev.luminosity + cur.luminosity) / 2) * elapsedDayFraction;
    }
    if (hasExcessiveGap) continue;

    totals.push({ date, totalMol });
  }

  return totals.sort((a, b) => (a.date < b.date ? 1 : -1));
}
