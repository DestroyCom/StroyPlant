# Onglet "Plante" + conseils Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Plante" tab to the device detail page showing the assigned species' full profile plus
4 Parrot-Pot-style advice cards (humidité/engrais/température/lumière), each showing verbatim Parrot
French copy selected from the device's already-computed Health Engine status.

**Architecture:** Backend computes structured advice (a status key + numeric/data placeholders only,
never composed French text) in a new pure module, exposed via a new tRPC procedure. Frontend owns a
static verbatim-text catalog and interpolates it. The device detail page gains page-level tabs
("Vue d'ensemble" / "Plante"); the species fiche is a component extracted out of the existing
`/plants/$id` route so both places share one implementation.

**Tech Stack:** TypeScript, Fastify/tRPC/Prisma (backend), React 19/TanStack Router/Query, Tailwind
v4 + shadcn/ui (frontend), `node:test` (backend tests only — no frontend test runner exists in this
project).

**Spec:** `docs/superpowers/specs/2026-09-03-plant-tab-advice-design.md`

## Global Constraints

- `pnpm` exclusively (never `npm`/`yarn`). TypeScript everywhere, never Python.
- Frontend typecheck is `cd frontend && pnpm typecheck` (`tsc -b --noEmit`) — **never** the bare root
  `npx tsc --noEmit`, which is a silent no-op that checks zero files (`CLAUDE.md` Gotchas).
- Backend typecheck/tests: `cd backend && pnpm exec tsc --noEmit && pnpm test` (`node:test`, files
  matched by the existing `*.test.ts` glob under `backend/src/health/`).
- Never silently swallow a BLE error (`docs/STROYPLANT_SPEC.md` section 7.1) — relevant only to
  Task 8's hardware script.
- No changes to `backend/src/health/scoring.ts`/`computeDeviceHealth` — this plan only consumes its
  output.
- The French text in `frontend/src/lib/plantAdviceText.ts` must be copied **verbatim** from the
  official Parrot app's decompiled string catalog (already extracted in the spec's mapping table,
  section 6) — never paraphrased or rewritten. Every sentence used in this plan's tasks is quoted
  exactly as found in `/Users/destcom/Documents/PERSO/parrot-pot-debug/analyse/decoded_jadx/resources/res/values-fr/strings.xml`.
- `PlantProfileFertilizerType.code === 1` is the generic "tout usage" type — excluded when counting
  a species' *specific* fertilizer types (matches the official app's own logic, confirmed by reading
  `Utility.java`'s `analyzeFertilizer`-equivalent switch, not guessed).

---

### Task 1: Extract `PlantProfileDetail` from `/plants/$id`

Pure refactor — moves the existing "Description"/"Entretien" tabs UI out of the route component into
a reusable component that takes a `plantProfile` prop, with zero behavior change on `/plants/$id`.
This lets Task 7 embed the exact same fiche inside the new "Plante" tab without duplicating logic.

**Files:**
- Create: `frontend/src/components/plant-profile-detail.tsx`
- Modify: `frontend/src/routes/_authenticated/plants_.$id.tsx`

**Interfaces:**
- Produces: `PlantProfileDetail({ plant }: { plant: PlantProfileDetailData })` — a React component.
  `PlantProfileDetailData` is the exact return type of the tRPC `plants.getById` query (import it via
  `inferOutput` — see Step 1 below for the precise type derivation). Renders the `Tabs`/`Card` block
  currently inline in `plants_.$id.tsx` (everything from `{!plant.hasParrotData ? (...) : (...)}`
  onward) — no wikipedia/back-button/header logic, that stays in the route.

- [ ] **Step 1: Create the component, moving the existing JSX verbatim**

```tsx
// frontend/src/components/plant-profile-detail.tsx
import type { AppRouter } from '@stroyplant/backend/api/trpc/router';
import type { inferRouterOutputs } from '@trpc/server';
import { NeedsGauge } from '@/components/needs-gauge';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// `inferRouterOutputs` (not the project's usual manual types.ts mirror, see CLAUDE.md's "Frontend —
// technical detail" for why that mirror normally avoids it) is safe here specifically because
// `plants.getById`'s output has no Date fields — the mirror's whole reason for existing (Date
// fields losing their reviver over the wire) doesn't apply to this one procedure's shape.
type RouterOutputs = inferRouterOutputs<AppRouter>;
export type PlantProfileDetailData = NonNullable<RouterOutputs['plants']['getById']>;

function formatRange(min: number | null, max: number | null, unit: string, decimals = 0): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${min.toFixed(decimals)}–${max.toFixed(decimals)}${unit}`;
  if (min != null) return `≥ ${min.toFixed(decimals)}${unit}`;
  return `≤ ${(max as number).toFixed(decimals)}${unit}`;
}

// Parrot's own generic per-category defaults, not real per-species measurements — see
// docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md. Kept raw in storage, this
// is the display-time filter (moved verbatim from plants_.$id.tsx).
function dropSentinel(
  min: number | null,
  max: number | null,
  isMinSentinel: (value: number) => boolean,
  isMaxSentinel: (value: number) => boolean,
): [number | null, number | null] {
  return [min != null && isMinSentinel(min) ? null : min, max != null && isMaxSentinel(max) ? null : max];
}

function formatZone(minValue: string | null, maxValue: string | null, minText: string | null, maxText: string | null): string | null {
  const range = minValue || maxValue ? [minValue, maxValue].filter(Boolean).join('–') : null;
  const text = [minText, maxText].filter(Boolean).join(' — ') || null;
  if (range && text) return `${range} · ${text}`;
  return range ?? text;
}

function TextSection({ title, text }: { title: string; text: string | null }) {
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-none">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

export function PlantProfileDetail({ plant }: { plant: PlantProfileDetailData }) {
  const [lightMin, lightMax] = dropSentinel(
    plant.lightMinMmol,
    plant.lightMaxMmol,
    () => false,
    (value) => value >= 99000,
  );
  const [conductivityMin, conductivityMax] = dropSentinel(
    plant.soilConductivityMinUsCm,
    plant.soilConductivityMaxUsCm,
    (value) => value < 0,
    () => false,
  );

  const availableRanges = [
    formatRange(plant.soilMoistureMinPercent, plant.soilMoistureMaxPercent, '%'),
    formatRange(plant.temperatureMinC, plant.temperatureMaxC, '°C'),
    formatRange(lightMin != null ? lightMin / 1000 : null, lightMax != null ? lightMax / 1000 : null, ' mol/m²/j', 1),
    formatRange(conductivityMin, conductivityMax, ' µS/cm'),
  ]
    .filter(Boolean)
    .join(' · ');

  if (!plant.hasParrotData) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-sm font-semibold text-foreground">Fiche limitée — données partielles</h2>
        <p className="text-sm text-muted-foreground">Plages disponibles : {availableRanges || 'aucune donnée numérique disponible'}</p>
      </Card>
    );
  }

  return (
    <Tabs defaultValue="description">
      <TabsList>
        <TabsTrigger value="description">Description</TabsTrigger>
        <TabsTrigger value="entretien">Entretien</TabsTrigger>
      </TabsList>

      <TabsContent value="description" className="flex flex-col gap-4">
        <Card className="flex flex-col p-4">
          <h2 className="mb-2 text-sm font-semibold text-foreground">Nomenclature</h2>
          <TextSection title="Nom scientifique" text={plant.name} />
          <TextSection title="Genre" text={plant.genusName} />
          <TextSection title="Espèce" text={plant.speciesName} />
          <TextSection title="Noms communs" text={plant.commonNames.length > 0 ? plant.commonNames.join(', ') : null} />
          <TextSection title="Synonymes" text={plant.synonyms} />
        </Card>
        <TextSection title="Description générale" text={plant.description} />
        <TextSection title="Faits intéressants" text={plant.interesting} />
        <Card className="flex flex-col p-4">
          <h2 className="mb-2 text-sm font-semibold text-foreground">Caractéristiques de la plante</h2>
          {plant.resolvedAttributes
            .filter(
              (attribute) =>
                attribute.group === 'type' ||
                attribute.group === 'lifetime' ||
                attribute.group === 'leafColor' ||
                attribute.group === 'shape' ||
                attribute.group === 'bloomColor',
            )
            .map((attribute) => (
              <TextSection key={`${attribute.group}-${attribute.valueLabel}`} title={attribute.groupLabel} text={attribute.valueLabel} />
            ))}
          <TextSection title="Taille" text={formatRange(plant.heightMinCm, plant.heightMaxCm, ' cm')} />
          <TextSection title="Expansion" text={formatRange(plant.spreadMinCm, plant.spreadMaxCm, ' cm')} />
        </Card>
        {plant.resolvedAttributes.some((attribute) => attribute.group === 'specialFeatures') && (
          <div className="flex flex-wrap gap-2">
            {plant.resolvedAttributes
              .filter((attribute) => attribute.group === 'specialFeatures')
              .map((attribute) => (
                <Badge key={attribute.valueLabel} variant="outline">
                  {attribute.valueLabel}
                </Badge>
              ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="entretien" className="flex flex-col gap-4">
        <Card className="flex flex-col p-4">
          <h2 className="mb-2 text-sm font-semibold text-foreground">Nutriments et besoins environnementaux</h2>
          {plant.waterCategory != null && (
            <NeedsGauge
              label="Arrosage"
              value={plant.waterCategory}
              rangeLabel={formatRange(plant.soilMoistureMinPercent, plant.soilMoistureMaxPercent, '%') ?? undefined}
            />
          )}
          {plant.sunCategory != null && (
            <NeedsGauge
              label="Ensoleillement"
              value={plant.sunCategory}
              rangeLabel={
                formatRange(lightMin != null ? lightMin / 1000 : null, lightMax != null ? lightMax / 1000 : null, ' mol/m²/j', 1) ?? undefined
              }
            />
          )}
          {plant.fertilizerCategory != null && (
            <NeedsGauge
              label="Engrais"
              value={plant.fertilizerCategory}
              rangeLabel={formatRange(conductivityMin, conductivityMax, ' µS/cm') ?? undefined}
            />
          )}
          <TextSection title="Températures" text={formatRange(plant.temperatureMinC, plant.temperatureMaxC, '°C')} />
        </Card>
        <TextSection title="Plantation" text={plant.planting} />
        <TextSection title="Croissance" text={plant.growth} />
        <TextSection title="Floraison" text={plant.blooming} />
        <TextSection title="Récolte" text={plant.harvesting} />
        <TextSection title="Sol et Irrigation" text={plant.soilIrr} />
        <TextSection title="Fertilisation" text={plant.fertilizerText} />
        {plant.fertilizerTypeLabels.length > 0 && (
          <div className="flex flex-col gap-1.5 border-b border-border py-3 last:border-none">
            <h3 className="text-sm font-semibold text-foreground">Types d'engrais recommandés</h3>
            <div className="flex flex-wrap gap-2">
              {plant.fertilizerTypeLabels.map((label) => (
                <Badge key={label} variant="outline">
                  {label}
                </Badge>
              ))}
            </div>
          </div>
        )}
        <TextSection title="Elagage" text={plant.pruning} />
        <TextSection title="Éléments nuisibles" text={plant.pests} />
        <TextSection title="Conseils complémentaires" text={plant.detailCare} />
        <TextSection
          title="Zone de rusticité"
          text={formatZone(plant.hardinessZoneMinValue, plant.hardinessZoneMaxValue, plant.hardinessZoneMinText, plant.hardinessZoneMaxText)}
        />
        <TextSection
          title="Zone de chaleur"
          text={plant.heatZoneMinText || plant.heatZoneMaxText ? [plant.heatZoneMinText, plant.heatZoneMaxText].filter(Boolean).join(' — ') : null}
        />
      </TabsContent>
    </Tabs>
  );
}
```

- [ ] **Step 2: Replace the inline JSX in `plants_.$id.tsx` with the extracted component**

In `frontend/src/routes/_authenticated/plants_.$id.tsx`:
1. Remove these now-unused items from the file: `NeedsGauge`, `Badge`, `Card`, `Tabs`/`TabsContent`/`TabsList`/`TabsTrigger` imports, `formatRange`, `dropSentinel`, `formatZone`, `TextSection`, and the `[lightMin, lightMax]`/`[conductivityMin, conductivityMax]`/`availableRanges` local variables plus the whole `{!plant.hasParrotData ? (...) : (...)}` JSX block.
2. Add `import { PlantProfileDetail } from '@/components/plant-profile-detail';`.
3. Replace the removed JSX block with:

```tsx
<PlantProfileDetail plant={plant} />
```

The route keeps its header (back button, name, Wikipedia link/image) exactly as-is — only the
tabs/fiche content moves out.

- [ ] **Step 3: Typecheck and verify no regression**

Run: `cd frontend && pnpm typecheck`
Expected: PASS, no errors in either file.

Manually verify (mock provider, dev server running): open `/plants/$id` for a Parrot-sourced species
(has `hasParrotData: true`) and for a WatchFlower-only one (`hasParrotData: false`) — both must render
identically to before this change.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/plant-profile-detail.tsx frontend/src/routes/_authenticated/plants_.\$id.tsx
git commit -m "refactor: extract PlantProfileDetail from /plants/\$id for reuse in the device Plante tab"
```

---

### Task 2: `plantAdvice.ts` — pure timing/prediction helpers

**Files:**
- Create: `backend/src/health/plantAdvice.ts`
- Test: `backend/src/health/plantAdvice.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (used by Task 3):
  - `WATERING_PREDICTION_WINDOW_DAYS: number` (constant, value `5`)
  - `MAX_WATERING_PREDICTION_DAYS: number` (constant, value `60`)
  - `daysCoveredForReadings(readings: Array<{ timestamp: Date }>): number`
  - `warmupHoursRemaining(daysCovered: number, warmupMinDays: number): number`
  - `hoursUntilDayEnd(now: Date, timezone: string): number`
  - `estimateDaysUntilWatering(readings: Array<{ timestamp: Date; soilMoisturePercent: number | null }>, minPercent: number): number | null`

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/health/plantAdvice.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pnpm test -- --test-name-pattern="plantAdvice"`
Expected: FAIL — `plantAdvice.js` does not exist yet.

- [ ] **Step 3: Implement the module**

```typescript
// backend/src/health/plantAdvice.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && pnpm test -- --test-name-pattern="plantAdvice"`
Expected: PASS, all cases green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/health/plantAdvice.ts backend/src/health/plantAdvice.test.ts
git commit -m "feat: add plantAdvice.ts timing/prediction helpers (warmup countdown, watering-date estimate)"
```

---

### Task 3: `plantAdvice.ts` — `buildPlantAdvice()` orchestrator

Maps a device's already-computed `DeviceHealth` (plus its raw readings, for live values and the
watering prediction) onto one `PlantAdvice` object — 4 slots, each either a typed advice record or
`null` when that sensor doesn't exist on this device. No French text anywhere in this file.

**Files:**
- Modify: `backend/src/health/plantAdvice.ts`
- Modify: `backend/src/health/plantAdvice.test.ts`

**Interfaces:**
- Consumes: `daysCoveredForReadings`, `warmupHoursRemaining`, `hoursUntilDayEnd`,
  `estimateDaysUntilWatering` (Task 2). `DeviceHealth`/`ParameterHealth` from
  `backend/src/health/scoring.js` (already exists — `ParameterHealth.speciesRange` is
  `[number, number | null] | null`, `ParameterHealth.status` is
  `'ok' | 'too_low' | 'too_high' | 'n/a' | 'calibrating'`). `ReadingWithRawLog` from
  `backend/src/health/soilConductivityCalibration.js` (already exists — `Reading & { rawSensorLog:
  RawSensorLog | null }`).
- Produces (used by Task 4):
  - `WaterAdviceKind = 'too_low' | 'too_high' | 'ok' | 'raw_no_profile'`
  - `TemperatureAdviceKind = 'too_low' | 'too_high' | 'ok' | 'soon_available' | 'no_plant' | 'raw_no_species_support'`
  - `LightAdviceKind = 'too_low' | 'too_high' | 'ok' | 'soon_available' | 'no_plant'`
  - `FertilizerAdviceKind = 'too_low' | 'too_high' | 'ok' | 'not_available' | 'no_plant'`
  - `WaterAdvice { kind, minPercent?, daysUntilWatering?, soilMoisturePercent: number | null, waterTankLevelPercent: number | null }`
  - `TemperatureAdvice { kind, isOutdoor: boolean, hoursRemaining?, temperatureC: number | null }`
  - `LightAdvice { kind, hoursRemaining? }`
  - `FertilizerAdvice { kind, typeLabels: string[] }`
  - `PlantAdvice { water: WaterAdvice | null; temperature: TemperatureAdvice | null; light: LightAdvice | null; fertilizer: FertilizerAdvice | null }`
  - `buildPlantAdvice(device: Pick<Device, 'kind' | 'environment'>, readings: ReadingWithRawLog[], health: DeviceHealth, warmupMinDays: number, timezone: string, fertilizerTypeLabels: string[]): PlantAdvice` —
    no `profile` parameter: `health.status`/`health.parameters` already fully reflect whether a
    species is assigned, so a separate `PlantProfile | null` argument would be redundant (and,
    if it were kept, unused — this project's frontend build enforces `noUnusedParameters` even on
    backend sources it project-references, see `CLAUDE.md` Gotchas).

**Important edge case, found while planning (not in the original spec)**: Xiaomi devices can
**never** have a species assigned — `supportsSpeciesProfile` in
`frontend/src/routes/_authenticated/devices.$deviceId.tsx` gates the whole "Espèce" section to
`PARROT_POT` only, so a Xiaomi device's `health.status` is *always* `'no_profile'`. Showing the
`temperature_no_plant_*` text (which tells the user to assign a species) on a device that
structurally has no way to do that would be actively misleading. `raw_no_species_support` is the
Xiaomi-only kind that shows the live temperature with no comparison text instead.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/health/plantAdvice.test.ts`:

```typescript
import type { DeviceHealth } from './scoring.js';
import { buildPlantAdvice } from './plantAdvice.js';

function fakeReading(overrides: Partial<{ timestamp: Date; soilMoisturePercent: number | null; waterTankLevelPercent: number | null; temperatureC: number | null; isInAir: boolean | null }> = {}) {
  return {
    id: 1,
    deviceId: 'TEST',
    timestamp: new Date(),
    soilMoisturePercent: null,
    temperatureC: null,
    luminosity: null,
    waterTankLevelPercent: null,
    soilConductivityUsCm: null,
    isDrySoil: null,
    isWetSoil: null,
    isEmptyTank: null,
    isInAir: null,
    humidityPercent: null,
    batteryPercent: null,
    source: 'POLL' as const,
    rawSensorLog: null,
    ...overrides,
  };
}

const NO_PROFILE_HEALTH: DeviceHealth = { status: 'no_profile', parameters: {}, trend: 'unknown', warningParameters: [], luminosityRecentDaysTooLow: false };

describe('buildPlantAdvice — water', () => {
  it('is null for a Xiaomi device (no soil probe)', () => {
    const advice = buildPlantAdvice({ kind: 'XIAOMI_LYWSD03MMC', environment: null }, [], NO_PROFILE_HEALTH, 3, 'UTC', []);
    assert.equal(advice.water, null);
  });

  it('shows raw values with no status when no species is assigned', () => {
    const readings = [fakeReading({ soilMoisturePercent: 42, waterTankLevelPercent: 80 })];
    const advice = buildPlantAdvice({ kind: 'PARROT_POT', environment: null }, readings, NO_PROFILE_HEALTH, 3, 'UTC', []);
    assert.deepEqual(advice.water, { kind: 'raw_no_profile', soilMoisturePercent: 42, waterTankLevelPercent: 80 });
  });

  it('reports too_low with the species threshold', () => {
    const readings = [fakeReading({ soilMoisturePercent: 15, waterTankLevelPercent: 60 })];
    const health: DeviceHealth = {
      status: 'warning',
      parameters: { soilMoisturePercent: { value: 15, status: 'too_low', speciesRange: [20, 60], personalDeviation: 'normal', liveValue: null } },
      trend: 'unknown',
      warningParameters: ['soilMoisturePercent'],
      luminosityRecentDaysTooLow: false,
    };
    const advice = buildPlantAdvice({ kind: 'PARROT_POT', environment: null }, readings, health, 3, 'UTC', []);
    assert.equal(advice.water?.kind, 'too_low');
    assert.equal(advice.water?.minPercent, 20);
  });
});

describe('buildPlantAdvice — temperature', () => {
  it('shows the raw value with no comparison on a Xiaomi device (no species assignment possible)', () => {
    const readings = [fakeReading({ temperatureC: 21 })];
    const advice = buildPlantAdvice({ kind: 'XIAOMI_LYWSD03MMC', environment: null }, readings, NO_PROFILE_HEALTH, 3, 'UTC', []);
    assert.deepEqual(advice.temperature, { kind: 'raw_no_species_support', isOutdoor: false, temperatureC: 21 });
  });

  it('shows no_plant on a Parrot Pot with no species assigned', () => {
    const advice = buildPlantAdvice({ kind: 'PARROT_POT', environment: null }, [], NO_PROFILE_HEALTH, 3, 'UTC', []);
    assert.equal(advice.temperature?.kind, 'no_plant');
  });

  it('shows soon_available with a real countdown while the device is warming up', () => {
    const readings = [fakeReading({ timestamp: new Date(Date.now() - 24 * 3600_000), temperatureC: 21 })];
    const health: DeviceHealth = { status: 'warming_up', parameters: { temperatureC: { value: 21, status: 'ok', speciesRange: [15, 25], personalDeviation: 'normal', liveValue: null } }, trend: 'unknown', warningParameters: [], luminosityRecentDaysTooLow: false };
    const advice = buildPlantAdvice({ kind: 'PARROT_POT', environment: null }, readings, health, 3, 'UTC', []);
    assert.equal(advice.temperature?.kind, 'soon_available');
    assert.ok(advice.temperature && advice.temperature.hoursRemaining! > 40 && advice.temperature.hoursRemaining! < 50);
  });
});

describe('buildPlantAdvice — fertilizer', () => {
  it('is null for a Xiaomi device', () => {
    const advice = buildPlantAdvice({ kind: 'XIAOMI_LYWSD03MMC', environment: null }, [], NO_PROFILE_HEALTH, 3, 'UTC', []);
    assert.equal(advice.fertilizer, null);
  });

  it('carries the species type labels for too_low', () => {
    const health: DeviceHealth = { status: 'warning', parameters: { soilConductivityUsCm: { value: 100, status: 'too_low', speciesRange: [500, 2000], personalDeviation: 'normal', liveValue: null } }, trend: 'unknown', warningParameters: [], luminosityRecentDaysTooLow: false };
    const advice = buildPlantAdvice({ kind: 'PARROT_POT', environment: null }, [], health, 3, 'UTC', ['Rose', 'Tomate']);
    assert.equal(advice.fertilizer?.kind, 'too_low');
    assert.deepEqual(advice.fertilizer?.typeLabels, ['Rose', 'Tomate']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && pnpm test -- --test-name-pattern="buildPlantAdvice"`
Expected: FAIL — `buildPlantAdvice` not exported yet.

- [ ] **Step 3: Implement the orchestrator**

Append to `backend/src/health/plantAdvice.ts`:

```typescript
import type { Device } from '@prisma/client';
import type { DeviceHealth } from './scoring.js';
import type { ReadingWithRawLog } from './soilConductivityCalibration.js';

export type WaterAdviceKind = 'too_low' | 'too_high' | 'ok' | 'raw_no_profile';
export type TemperatureAdviceKind = 'too_low' | 'too_high' | 'ok' | 'soon_available' | 'no_plant' | 'raw_no_species_support';
export type LightAdviceKind = 'too_low' | 'too_high' | 'ok' | 'soon_available' | 'no_plant';
export type FertilizerAdviceKind = 'too_low' | 'too_high' | 'ok' | 'not_available' | 'no_plant';

export interface WaterAdvice {
  kind: WaterAdviceKind;
  minPercent?: number;
  daysUntilWatering?: number;
  soilMoisturePercent: number | null;
  waterTankLevelPercent: number | null;
}

export interface TemperatureAdvice {
  kind: TemperatureAdviceKind;
  isOutdoor: boolean;
  hoursRemaining?: number;
  temperatureC: number | null;
}

export interface LightAdvice {
  kind: LightAdviceKind;
  hoursRemaining?: number;
}

export interface FertilizerAdvice {
  kind: FertilizerAdviceKind;
  typeLabels: string[];
}

export interface PlantAdvice {
  water: WaterAdvice | null;
  temperature: TemperatureAdvice | null;
  light: LightAdvice | null;
  fertilizer: FertilizerAdvice | null;
}

function mostRecentValue<R, K extends keyof R>(readings: R[], key: K): R[K] | null {
  for (let i = readings.length - 1; i >= 0; i--) {
    const value = readings[i][key];
    if (value != null) return value;
  }
  return null;
}

function buildWaterAdvice(device: Pick<Device, 'kind'>, sorted: ReadingWithRawLog[], health: DeviceHealth): WaterAdvice | null {
  if (device.kind !== 'PARROT_POT') return null;
  const soilMoisturePercent = mostRecentValue(sorted, 'soilMoisturePercent');
  const waterTankLevelPercent = mostRecentValue(sorted, 'waterTankLevelPercent');

  const param = health.parameters.soilMoisturePercent;
  if (!param || param.speciesRange == null) {
    return { kind: 'raw_no_profile', soilMoisturePercent, waterTankLevelPercent };
  }

  const minPercent = param.speciesRange[0];
  if (param.status === 'too_low') return { kind: 'too_low', minPercent, soilMoisturePercent, waterTankLevelPercent };
  if (param.status === 'too_high') return { kind: 'too_high', minPercent, soilMoisturePercent, waterTankLevelPercent };

  const daysUntilWatering = estimateDaysUntilWatering(sorted, minPercent) ?? undefined;
  return { kind: 'ok', minPercent, daysUntilWatering, soilMoisturePercent, waterTankLevelPercent };
}

function buildTemperatureAdvice(
  device: Pick<Device, 'kind' | 'environment'>,
  sorted: ReadingWithRawLog[],
  health: DeviceHealth,
  globalHoursRemaining: number,
): TemperatureAdvice | null {
  const temperatureC = mostRecentValue(sorted, 'temperatureC');
  const isOutdoor = device.environment === 'OUTDOOR';

  if (device.kind === 'XIAOMI_LYWSD03MMC') return { kind: 'raw_no_species_support', isOutdoor, temperatureC };
  if (health.status === 'no_profile') return { kind: 'no_plant', isOutdoor, temperatureC };
  if (health.status === 'warming_up') return { kind: 'soon_available', isOutdoor, hoursRemaining: globalHoursRemaining, temperatureC };

  const param = health.parameters.temperatureC;
  if (!param || param.status === 'n/a') return null;
  if (param.status === 'too_low') return { kind: 'too_low', isOutdoor, temperatureC };
  if (param.status === 'too_high') return { kind: 'too_high', isOutdoor, temperatureC };
  return { kind: 'ok', isOutdoor, temperatureC };
}

function buildLightAdvice(device: Pick<Device, 'kind'>, health: DeviceHealth, globalHoursRemaining: number, now: Date, timezone: string): LightAdvice | null {
  if (device.kind !== 'PARROT_POT') return null;
  if (health.status === 'no_profile') return { kind: 'no_plant' };
  if (health.status === 'warming_up') return { kind: 'soon_available', hoursRemaining: globalHoursRemaining };

  const param = health.parameters.luminosity;
  if (!param || param.status === 'n/a') return null;
  // Part H's own "zero complete calendar days yet" gate — independent of the device-wide warmup
  // above, see health/scoring.ts's luminosity branch and health/dailyLightIntegral.ts.
  if (param.status === 'calibrating') return { kind: 'soon_available', hoursRemaining: hoursUntilDayEnd(now, timezone) };
  if (param.status === 'too_low') return { kind: 'too_low' };
  if (param.status === 'too_high') return { kind: 'too_high' };
  return { kind: 'ok' };
}

function buildFertilizerAdvice(device: Pick<Device, 'kind'>, health: DeviceHealth, fertilizerTypeLabels: string[]): FertilizerAdvice | null {
  if (device.kind !== 'PARROT_POT') return null;
  if (health.status === 'no_profile') return { kind: 'no_plant', typeLabels: [] };

  const param = health.parameters.soilConductivityUsCm;
  if (!param) return null;
  if (param.status === 'calibrating' || param.status === 'n/a') return { kind: 'not_available', typeLabels: [] };
  if (param.status === 'too_low') return { kind: 'too_low', typeLabels: fertilizerTypeLabels };
  if (param.status === 'too_high') return { kind: 'too_high', typeLabels: [] };
  return { kind: 'ok', typeLabels: [] };
}

/**
 * Maps a device's already-computed DeviceHealth (health/scoring.ts's computeDeviceHealth) onto the
 * 4-category advice structure the "Plante" tab renders — a status key plus data placeholders only,
 * never composed French text (that lives in the frontend's plantAdviceText.ts). `fertilizerTypeLabels`
 * is the caller-resolved list of this species' specific (non-"tout usage") fertilizer type labels.
 */
export function buildPlantAdvice(
  device: Pick<Device, 'kind' | 'environment'>,
  readings: ReadingWithRawLog[],
  health: DeviceHealth,
  warmupMinDays: number,
  timezone: string,
  fertilizerTypeLabels: string[],
): PlantAdvice {
  const sorted = readings.filter((r) => r.isInAir !== true).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const daysCovered = daysCoveredForReadings(sorted);
  const globalHoursRemaining = warmupHoursRemaining(daysCovered, warmupMinDays);
  const now = new Date();

  return {
    water: buildWaterAdvice(device, sorted, health),
    temperature: buildTemperatureAdvice(device, sorted, health, globalHoursRemaining),
    light: buildLightAdvice(device, health, globalHoursRemaining, now, timezone),
    fertilizer: buildFertilizerAdvice(device, health, fertilizerTypeLabels),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && pnpm test -- --test-name-pattern="buildPlantAdvice"`
Expected: PASS.

- [ ] **Step 5: Full backend verification**

Run: `cd backend && pnpm exec tsc --noEmit && pnpm test`
Expected: both clean, all tests passing (including the pre-existing 197).

- [ ] **Step 6: Commit**

```bash
git add backend/src/health/plantAdvice.ts backend/src/health/plantAdvice.test.ts
git commit -m "feat: add buildPlantAdvice orchestrator mapping DeviceHealth to the 4-category advice structure"
```

---

### Task 4: tRPC `health.plantAdvice` procedure

**Files:**
- Modify: `backend/src/api/trpc/routers/health.ts`

**Interfaces:**
- Consumes: `buildPlantAdvice` (Task 3), `computeDeviceHealth` (existing, `health/scoring.js`),
  `getHealthSettings` (existing, `health/settings.js`), `getCalibration` (existing,
  `health/soilConductivityCalibration.js`).
- Produces: `health.plantAdvice` tRPC query, input `{ deviceId: string }`, output `PlantAdvice`
  (Task 3's type) — consumed by Task 6.

- [ ] **Step 1: Add the procedure**

In `backend/src/api/trpc/routers/health.ts`, add this import alongside the existing ones:

```typescript
import { buildPlantAdvice } from '../../../health/plantAdvice.js';
```

Add this procedure to the `healthRouter` object, after `deviceHealth`:

```typescript
  plantAdvice: protectedProcedure.input(z.object({ deviceId: z.string() })).query(async ({ input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId }, include: { plantProfile: true } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    const healthSettings = await getHealthSettings();
    const since = new Date(Date.now() - healthSettings.baselineWindowDays * 24 * 3600_000);
    const readings = await prisma.reading.findMany({
      where: { deviceId: device.id, timestamp: { gte: since }, source: 'POLL' },
      orderBy: { timestamp: 'asc' },
      include: { rawSensorLog: true },
    });
    const conductivityCalibration = await getCalibration(device.id);

    const health = computeDeviceHealth(
      device,
      readings,
      device.plantProfile,
      healthSettings.warmupMinDays,
      conductivityCalibration,
      healthSettings.timezone,
    );

    // Excludes the generic "tout usage" type (code 1) — matches the official app's own logic
    // (Utility.java's fertilizer_too_low branch), see this plan's Global Constraints.
    const fertilizerTypeLabels = device.plantProfile
      ? (
          await prisma.plantProfileFertilizerType.findMany({
            where: { plantProfileId: device.plantProfile.id, code: { not: 1 } },
            orderBy: { code: 'asc' },
          })
        )
          .map((entry) => resolveFertilizerTypeLabel(entry.code))
          .filter((label): label is string => label != null)
      : [];

    return buildPlantAdvice(device, readings, health, healthSettings.warmupMinDays, healthSettings.timezone, fertilizerTypeLabels);
  }),
```

Add this import alongside the others (it's from the same module Task-adjacent code in `plants.ts`
already imports):

```typescript
import { resolveFertilizerTypeLabel } from '../../../health/parrotFilterLabels.js';
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Manual verification against the mock provider**

Start the backend dev server (mock provider), sign in, then:

```bash
curl -s -b cookies.txt -X POST 'http://localhost:3000/api/trpc/health.plantAdvice?batch=1' \
  -H 'content-type: application/json' \
  -d '{"0":{"json":{"deviceId":"MOCK-POT-NORMAL"}}}' | jq .
```

(Reuse the same cookie-jar login flow already used for prior manual tRPC verifications in this
project — sign in via `/api/auth/sign-in/email` first if `cookies.txt` doesn't exist yet.)

Expected: a JSON object with `water`/`temperature`/`light`/`fertilizer` keys, each either `null` or a
plausible advice object matching Task 3's shapes, for both a species-assigned and a
no-species-assigned mock device.

- [ ] **Step 4: Commit**

```bash
git add backend/src/api/trpc/routers/health.ts
git commit -m "feat: add health.plantAdvice tRPC procedure"
```

---

### Task 5: Frontend `plantAdviceText.ts` — verbatim text catalog

Every French sentence below is copied exactly from
`/Users/destcom/Documents/PERSO/parrot-pot-debug/analyse/decoded_jadx/resources/res/values-fr/strings.xml`
— do not reword any of them (see this plan's Global Constraints).

**Files:**
- Create: `frontend/src/lib/plantAdviceText.ts`

**Interfaces:**
- Consumes: the `WaterAdvice`/`TemperatureAdvice`/`LightAdvice`/`FertilizerAdvice` shapes from
  Task 3 — imported via the tRPC output type (see Step 1), not hand-duplicated.
- Produces (used by Task 6):
  - `formatHoursRemaining(hours: number): string`
  - `waterAdviceText(advice: WaterAdvice): string`
  - `temperatureAdviceText(advice: TemperatureAdvice, deviceKind: 'PARROT_POT' | 'XIAOMI_LYWSD03MMC'): string`
  - `lightAdviceText(advice: LightAdvice): string`
  - `fertilizerAdviceText(advice: FertilizerAdvice): string`

- [ ] **Step 1: Create the catalog and interpolation functions**

```typescript
// frontend/src/lib/plantAdviceText.ts
//
// Verbatim French copy from the official Parrot Flower Power app (decompiled APK resources,
// res/values-fr/strings.xml) — see docs/superpowers/specs/2026-09-03-plant-tab-advice-design.md's
// "Décision explicite : réutilisation verbatim du texte Parrot" section for why, and CLAUDE.md for
// the IP-risk acknowledgment. Do not reword any sentence in this file — if a variant is missing,
// add it from the same source file, never invent one.
import type { AppRouter } from '@stroyplant/backend/api/trpc/router';
import type { inferRouterOutputs } from '@trpc/server';

// Same `inferRouterOutputs` rationale as plant-profile-detail.tsx (Task 1) — `health.plantAdvice`'s
// output has no Date fields, so the project's usual Date-serialization concern for the manual
// types.ts mirror doesn't apply here.
type PlantAdvice = NonNullable<inferRouterOutputs<AppRouter>['health']['plantAdvice']>;
export type WaterAdvice = NonNullable<PlantAdvice['water']>;
export type TemperatureAdvice = NonNullable<PlantAdvice['temperature']>;
export type LightAdvice = NonNullable<PlantAdvice['light']>;
export type FertilizerAdvice = NonNullable<PlantAdvice['fertilizer']>;

// "3 heures" below 24h, otherwise "2 jours" — Parrot's own getTimeHours() helper formats similarly
// (Utility.java), reimplemented here since the exact French rounding/plural rules aren't specified
// by any string in the catalog itself.
export function formatHoursRemaining(hours: number): string {
  if (hours < 24) {
    const rounded = Math.max(1, Math.round(hours));
    return `${rounded} heure${rounded > 1 ? 's' : ''}`;
  }
  const days = Math.max(1, Math.round(hours / 24));
  return `${days} jour${days > 1 ? 's' : ''}`;
}

export function waterAdviceText(advice: WaterAdvice): string {
  switch (advice.kind) {
    case 'too_low':
      return "Arrosez votre plante. Quand vous arrosez votre plante, faites-le de manière homogène. Les racines de votre plante peuvent s'enfoncer profondément dans le sol, arrosez donc généreusement pour que l'eau pénètre jusqu'aux racines les plus profondes.";
    case 'too_high':
      return "La quantité d'eau dans la terre est restée anormalement élevée pendant une durée trop importante pour votre plante. Trop d'eau dans la terre peut asphyxier votre plante en empêchant les racines d'absorber l'oxygène. Assurez-vous que le drainage est suffisant afin de permettre au surplus d'eau de s'échapper.";
    case 'ok': {
      const base = "Votre plante a suffisamment d'eau pour le moment. Bien arroser votre plante est la première chose à faire pour la maintenir resplendissante et en bonne santé.";
      if (advice.daysUntilWatering != null && advice.minPercent != null) {
        return `${base} Le prochain arrosage automatique sera déclenché dans ${advice.daysUntilWatering} jour${advice.daysUntilWatering > 1 ? 's' : ''}, après être passé sous le seuil de ${Math.round(advice.minPercent)}% d'humidité.`;
      }
      if (advice.minPercent != null) {
        return `${base} Nous vous conseillons d'arroser votre plante après être passé sous le seuil de ${Math.round(advice.minPercent)}% d'humidité.`;
      }
      return base;
    }
    case 'raw_no_profile':
      return 'Assignez une espèce à ce pot pour obtenir un conseil personnalisé sur son besoin en eau.';
  }
}

export function temperatureAdviceText(advice: TemperatureAdvice, deviceKind: 'PARROT_POT' | 'XIAOMI_LYWSD03MMC'): string {
  const product = deviceKind === 'PARROT_POT' ? 'Parrot Pot' : 'capteur';
  switch (advice.kind) {
    case 'too_low':
      return advice.isOutdoor
        ? "À cause du froid, le métabolisme de votre plante se ralentit. Si vous le pouvez, rentrez votre plante à l'intérieur ou couvrez-la pour augmenter sa température."
        : "À cause du froid, le métabolisme de votre plante se ralentit. Si vous le pouvez, déplacez votre plante vers un endroit plus chaud.";
    case 'too_high':
      return 'Le métabolisme de votre plante se ralentit car elle a trop chaud. Si possible, déplacez votre plante vers un endroit plus frais, plus exposé au vent et/ou plus ombragé.';
    case 'ok':
      return "Tout va bien. La température des derniers jours permet à votre plante de s'épanouir pleinement.";
    case 'soon_available': {
      const base = `Une analyse complète de l'environnement de votre ${product} va être effectuée pendant les premières 24 heures suivant son installation.\nCette période est nécessaire pour vous fournir des conseils de température fiables, et adaptés aux besoins de votre plante.`;
      return advice.hoursRemaining != null ? `${base}\nConseil disponible dans ${formatHoursRemaining(advice.hoursRemaining)}.` : base;
    }
    case 'no_plant':
      return 'Afin de générer des conseils de température fiables, veuillez assigner une plante.';
    case 'raw_no_species_support':
      return "Ce capteur ne prend pas en charge l'assignation d'une espèce — la température est affichée sans comparaison personnalisée.";
  }
}

export function lightAdviceText(advice: LightAdvice): string {
  switch (advice.kind) {
    case 'too_low':
      return "Votre plante apprécierait de recevoir plus de lumière. Avec ce niveau d'ensoleillement son métabolisme va ralentir et elle va cesser de grandir. Si le manque de lumière n'est pas simplement lié au mauvais temps, vérifiez que rien n'empêche l'accès du capteur d'ensoleillement à la lumière et assurez-vous que votre plante est à l'endroit le plus lumineux possible.";
    case 'too_high':
      return 'Votre plante reçoit trop de lumière. Trop de lumière peut entraîner la décoloration des feuilles, une période de floraison plus courte et va diminuer la santé de votre plante. Si possible, déplacez votre plante vers un endroit plus ombragé ou abritez-la des rayons directs du soleil.';
    case 'ok':
      return "L'ensoleillement des derniers jours permet à votre plante de s'épanouir pleinement.";
    case 'soon_available': {
      const base = "Une analyse complète de l'environnement de votre Parrot Pot doit être effectuée pendant les premières 24 heures suivant son installation.\nCette période est nécessaire pour vous fournir des conseils fiables relatifs à la luminosité la plus adaptée aux besoins de votre plante.";
      return advice.hoursRemaining != null ? `${base}\nConseil disponible dans ${formatHoursRemaining(advice.hoursRemaining)}.` : base;
    }
    case 'no_plant':
      return 'Afin de générer des conseils de luminosité fiables, veuillez assigner une plante.';
  }
}

export function fertilizerAdviceText(advice: FertilizerAdvice): string {
  const closing = " Lors de l'utilisation d'un engrais, suivez toujours les instructions précisées sur l'emballage.";
  switch (advice.kind) {
    case 'too_low': {
      const intro = 'Votre plante apprécierait un niveau d\'engrais plus élevé.';
      if (advice.typeLabels.length === 0) {
        return `${intro} L'ajout d'engrais universel serait bénéfique à votre plante en lui apportant les nutriments nécessaires.${closing}`;
      }
      if (advice.typeLabels.length === 1) {
        return `${intro} Un engrais spécialisé pour ${advice.typeLabels[0]} serait parfait pour votre plante, ou à défaut un engrais universel serait bénéfique à votre plante en lui apportant les nutriments nécessaires.${closing}`;
      }
      const allButLast = advice.typeLabels.slice(0, -1).join(', ');
      const last = advice.typeLabels[advice.typeLabels.length - 1];
      return `${intro} Un engrais spécialisé pour ${allButLast} ou ${last} serait parfait pour votre plante, ou à défaut un engrais universel serait bénéfique à votre plante en lui apportant les nutriments nécessaires.${closing}`;
    }
    case 'too_high':
      return "Il y a trop d'engrais dans la terre pour votre plante. Pour éviter une trop forte concentration d'engrais dans le sol, arrosez abondamment votre plante. Une partie de l'engrais devrait s'évacuer avec le surplus d'eau, ce qui devrait aider à réduire sa concentration.";
    case 'ok':
      return "Le niveau d'engrais est dans les limites préconisées pour cette plante.";
    case 'not_available':
      return "Une analyse complète de l'environnement de votre Parrot Pot va être effectuée.\nCette période est nécessaire pour vous fournir des conseils d'engrais fiables.\nSi la terre est trop sèche ou trop humide depuis longtemps, nous ne pourrons réaliser une analyse fiable de la fertilisation. Par conséquent, les niveaux d'engrais et les recommandations seront indisponibles jusqu'au retour à la normale du niveau d'humidité de la terre.";
    case 'no_plant':
      return 'Afin de générer des conseils de fertilisation fiables, veuillez assigner une plante.';
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS. (No usage yet, so no runtime check possible in this task.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/plantAdviceText.ts
git commit -m "feat: add verbatim Parrot advice text catalog (plantAdviceText.ts)"
```

---

### Task 6: `PlantAdviceTab` component

**Files:**
- Create: `frontend/src/components/plant-advice-tab.tsx`

**Interfaces:**
- Consumes: `trpc.health.plantAdvice` (Task 4), `waterAdviceText`/`temperatureAdviceText`/
  `lightAdviceText`/`fertilizerAdviceText`/`formatHoursRemaining` (Task 5).
- Produces: `PlantAdviceTab({ deviceId, deviceKind }: { deviceId: string; deviceKind: 'PARROT_POT' |
  'XIAOMI_LYWSD03MMC' })` — used by Task 7.

- [ ] **Step 1: Create the component**

```tsx
// frontend/src/components/plant-advice-tab.tsx
import { useQuery } from '@tanstack/react-query';
import { Droplets, FlaskConical, Sun, Thermometer } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { fertilizerAdviceText, lightAdviceText, temperatureAdviceText, waterAdviceText } from '@/lib/plantAdviceText';
import { trpc } from '@/lib/trpc';

function AdviceCard({ icon, label, liveValues, text }: { icon: ReactNode; label: string; liveValues?: string; text: string }) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        {liveValues && <span className="ml-auto text-sm font-medium text-foreground">{liveValues}</span>}
      </div>
      <p className="whitespace-pre-line text-sm text-muted-foreground">{text}</p>
    </Card>
  );
}

export function PlantAdviceTab({ deviceId, deviceKind }: { deviceId: string; deviceKind: 'PARROT_POT' | 'XIAOMI_LYWSD03MMC' }) {
  const { data: advice, isLoading, error } = useQuery(trpc.health.plantAdvice.queryOptions({ deviceId }, { refetchInterval: 60_000 }));

  if (isLoading) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  if (error || !advice) return <p className="text-sm text-destructive">Impossible de charger les conseils pour cet appareil.</p>;

  return (
    <div className="flex flex-col gap-4">
      {advice.water && (
        <AdviceCard
          icon={<Droplets size={16} />}
          label="Humidité de la terre"
          liveValues={
            [
              advice.water.soilMoisturePercent != null ? `${Math.round(advice.water.soilMoisturePercent)}%` : null,
              advice.water.waterTankLevelPercent != null ? `Réservoir ${Math.round(advice.water.waterTankLevelPercent)}%` : null,
            ]
              .filter(Boolean)
              .join(' · ') || undefined
          }
          text={waterAdviceText(advice.water)}
        />
      )}
      {advice.temperature && (
        <AdviceCard
          icon={<Thermometer size={16} />}
          label="Température"
          liveValues={advice.temperature.temperatureC != null ? `${Math.round(advice.temperature.temperatureC)}°` : undefined}
          text={temperatureAdviceText(advice.temperature, deviceKind)}
        />
      )}
      {advice.light && <AdviceCard icon={<Sun size={16} />} label="Lumière" text={lightAdviceText(advice.light)} />}
      {advice.fertilizer && <AdviceCard icon={<FlaskConical size={16} />} label="Engrais" text={fertilizerAdviceText(advice.fertilizer)} />}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/plant-advice-tab.tsx
git commit -m "feat: add PlantAdviceTab component"
```

---

### Task 7: Wire page-level tabs into the device detail page

Restructures `devices.$deviceId.tsx` into 2 page-level tabs — "Vue d'ensemble" (all existing content,
unchanged) and "Plante" (species fiche + `PlantAdviceTab`, Parrot Pot only — a Xiaomi device has no
species assignment UI at all, see Task 3's edge case note, so it gets no "Plante" tab).

**Files:**
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.tsx`

**Interfaces:**
- Consumes: `PlantProfileDetail` (Task 1), `PlantAdviceTab` (Task 6), `trpc.plants.getById`
  (existing).

- [ ] **Step 1: Add the page-level Tabs wrapper**

In `frontend/src/routes/_authenticated/devices.$deviceId.tsx`:

1. Add imports:

```tsx
import { PlantAdviceTab } from '@/components/plant-advice-tab';
import { PlantProfileDetail } from '@/components/plant-profile-detail';
```

2. Add this query inside `DeviceDetailPage`, alongside the existing `useQuery` calls (after the
   `health` query):

```tsx
  const { data: plantProfileDetail } = useQuery(
    trpc.plants.getById.queryOptions({ id: device.plantProfile?.id ?? -1 }, { enabled: device.plantProfile != null }),
  );
```

3. Wrap the section from `{supportsSpeciesProfile && (...Espèce card...)}` through the end of the
   `{canWater && (...Détails techniques...)}` block — i.e. everything currently between the header
   (`<h1>`/watering buttons) and the `<EditDeviceDialog>` at the bottom — in a page-level `Tabs`.
   Concretely, replace this span of JSX:

```tsx
      {supportsSpeciesProfile && (
        <div className="my-7 rounded-lg border border-border-subtle p-4">
          {/* ... unchanged ... */}
        </div>
      )}

      {supportsSpeciesProfile && (
        <SpeciesPickerDialog open={speciesOpen} onOpenChange={setSpeciesOpen} deviceId={deviceId} currentProfile={device.plantProfile} />
      )}

      {canWater && <AutoWateringSection ... />}
      {canWater && <AutonomousWateringSection ... />}
      {canWater && (
        <div className="my-7 flex items-center justify-between gap-3 rounded-lg border border-border-subtle p-4">
          {/* Calibration Plant Dr */}
        </div>
      )}
      {canWater && (
        <div className="my-7">
          {/* Derniers arrosages */}
        </div>
      )}

      <div className="border-t border-border-subtle pt-4">
        {/* Détails techniques */}
      </div>
```

with:

```tsx
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Vue d'ensemble</TabsTrigger>
          {supportsSpeciesProfile && <TabsTrigger value="plant">Plante</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="flex flex-col">
          {supportsSpeciesProfile && (
            <div className="my-7 rounded-lg border border-border-subtle p-4">
              {/* ... unchanged content from the removed block above ... */}
            </div>
          )}

          {supportsSpeciesProfile && (
            <SpeciesPickerDialog open={speciesOpen} onOpenChange={setSpeciesOpen} deviceId={deviceId} currentProfile={device.plantProfile} />
          )}

          {canWater && <AutoWateringSection deviceId={deviceId} hasSpeciesAssigned={device.plantProfile != null} />}
          {canWater && (
            <AutonomousWateringSection deviceId={deviceId} plantProfile={device.plantProfile} autonomousWateringActive={device.autonomousWateringActive} />
          )}

          {canWater && (
            <div className="my-7 flex items-center justify-between gap-3 rounded-lg border border-border-subtle p-4">
              {/* ... unchanged Calibration Plant Dr content ... */}
            </div>
          )}

          {canWater && (
            <div className="my-7">
              {/* ... unchanged Derniers arrosages content ... */}
            </div>
          )}

          <div className="border-t border-border-subtle pt-4">
            {/* ... unchanged Détails techniques content ... */}
          </div>
        </TabsContent>

        {supportsSpeciesProfile && (
          <TabsContent value="plant" className="flex flex-col gap-6 py-5">
            {device.plantProfile && plantProfileDetail ? (
              <PlantProfileDetail plant={plantProfileDetail} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Aucune espèce assignée — assigne une espèce dans l'onglet "Vue d'ensemble" pour voir sa fiche et des conseils personnalisés.
              </p>
            )}
            <PlantAdviceTab deviceId={deviceId} deviceKind={device.kind} />
          </TabsContent>
        )}
      </Tabs>
```

Keep every piece of JSX marked `{/* ... unchanged ... */}` above byte-for-byte identical to what it
replaces — this step only adds the `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` wrapper and the new
"Plante" tab content, it must not alter any existing card's content or logic. The existing
`techOpen`/`setTechOpen` collapsible "Détails techniques" section keeps working exactly as before,
now simply nested one level deeper inside `TabsContent value="overview"`.

Note: this device detail page already imports `Tabs`/`TabsContent`/`TabsList`/`TabsTrigger` (used by
the existing 24h/7j/30j period selector) — no new import needed for those.

- [ ] **Step 2: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Manual verification**

Against the mock provider, in a real browser:
1. Open a Parrot Pot device with a species assigned — confirm "Vue d'ensemble" renders exactly as
   before (gauges, history, waterings, auto-watering, calibration link all present and unchanged),
   and "Plante" shows the species fiche (Task 1's component) plus up to 4 advice cards (Task 6) with
   plausible text.
2. Open a Parrot Pot device with **no** species assigned — "Plante" tab shows the
   "aucune espèce assignée" message above `PlantAdviceTab`, and the water card shows raw values with
   the `raw_no_profile` text, temperature/light/fertilizer show `no_plant` text.
3. Open a Xiaomi device — no "Plante" tab appears at all (`supportsSpeciesProfile` is false),
   "Vue d'ensemble" is unchanged.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/routes/_authenticated/devices.\$deviceId.tsx
git commit -m "feat: add page-level Vue d'ensemble/Plante tabs to the device detail page"
```

---

### Task 8: `39e1FE05` (tank capacity) hardware verification

**This task is executed differently from Tasks 1-7**: the script itself (Step 1) is a normal
implementer deliverable (reviewable by reading the code — same as every prior `hwtest-*.ts` script
in this project), but **actually running it against real hardware (Step 2 onward) cannot be
dispatched to a generic implementer subagent** — it needs SSH access to the production server and a
stopped `stroyplant` container (shared Bluetooth adapter), exactly like `hwtest-watering-config-
checksum.ts`/`hwtest-live-fast-path-watering-8733.ts` before it. The orchestrating session (or
DestCom) runs Steps 2-4 directly, not through subagent-driven-development's normal per-task
dispatch loop.

**Files:**
- Create: `backend/scripts/hwtest-tank-capacity-8733.ts`
- Conditionally (only if Step 3 confirms a plausible encoding): `backend/prisma/schema.prisma`
  (new migration), `backend/src/ble/parrot/uuids.ts`, `backend/src/providers/mock/index.ts`,
  `backend/src/providers/node-ble/index.ts`, `frontend/src/components/plant-advice-tab.tsx` (switch
  the water card's reservoir display from percent to liters).

**Interfaces:**
- Consumes: `createNodeBleProvider` is not reused here — `39e1FE05` has never been read by any
  provider, so this script talks to `node-ble` directly (same low-level pattern this project's
  earliest Batch 6 Plant Dr spike used, before the high-level provider existed).

- [ ] **Step 1: Write the hardware verification script**

```typescript
// backend/scripts/hwtest-tank-capacity-8733.ts
// One-off, disposable hardware verification script — NOT part of the app, not committed to run in
// CI. Reads the never-before-read 39e1FE05 (UUID_TANK_CAPACITY, "Certain" confidence in
// docs/PARROT_BLE_REVERSE_ENGINEERING.md) characteristic on a real Parrot Pot, to empirically
// confirm what unit/encoding it uses before trusting it for a liters display (spec section 9 —
// "no guessing" rule). Target: pot 8733 (A0:14:3D:CD:87:33), the dedicated no-species-assigned test
// pot. Run only with the production `stroyplant` container stopped (shared Bluetooth adapter).
import { createBluetooth } from 'node-ble';
import { CALIBRATION_SERVICE_UUID } from '../src/ble/parrot/uuids.js';

const DEVICE_ID = 'A0:14:3D:CD:87:33';
const TANK_CAPACITY_CHARACTERISTIC_UUID = '39e1fe05-84a8-11e2-afba-0002a5d5c51b';

async function main() {
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
    console.log('Waiting for device advertisement...');
    const device = await adapter.waitDevice(DEVICE_ID);
    await adapter.stopDiscovery();

    console.log('Connecting...');
    await device.connect();
    const gatt = await device.gatt();
    const service = await gatt.getPrimaryService(CALIBRATION_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(TANK_CAPACITY_CHARACTERISTIC_UUID);

    const buffer = await characteristic.readValue();
    console.log(`Raw bytes (${buffer.length}): ${buffer.toString('hex')}`);
    if (buffer.length >= 1) console.log(`As uint8: ${buffer.readUInt8(0)}`);
    if (buffer.length >= 2) console.log(`As uint16 LE: ${buffer.readUInt16LE(0)}`);

    await device.disconnect();
  } finally {
    destroy();
  }
}

main().catch((error) => {
  console.error('FATAL:', error);
  process.exit(1);
});
```

- [ ] **Step 2 (MANUAL — orchestrator/DestCom, not a subagent dispatch): run the script**

On the production server (SSH), with the `stroyplant` container stopped, in a disposable
`node:22-bookworm-slim` container mounting the backend source (same procedure as every prior
`hwtest-*.ts` run in this project's history — see `CLAUDE.md`'s entries for
`hwtest-watering-config-checksum.ts`/`hwtest-live-fast-path-watering-8733.ts` for the exact
container/mount commands to reuse):

```bash
pnpm exec tsx backend/scripts/hwtest-tank-capacity-8733.ts
```

Record the raw hex/uint8/uint16 output.

- [ ] **Step 3 (MANUAL — DestCom): compare against the real physical capacity**

DestCom checks the Parrot Pot's actual marketed/measured reservoir capacity (commonly cited as
2.2L, but confirm rather than assume — see this plan's Global Constraints on never guessing an
encoding). Compare the raw value from Step 2 against that real number under a few plausible unit
hypotheses (raw value directly in centiliters, in deciliters, raw × a small constant in mL, etc.).

- [ ] **Step 4: Branch on the result**

**If a hypothesis reconstructs the known real capacity plausibly** (e.g. raw=22 and the pot holds
2.2L → centiliters): wire it in as a small follow-up (not detailed further here, since the exact
schema/UI change depends on which encoding is confirmed) —
add `tankCapacityRaw Int? // fe05` to `RawSensorLog` under its existing "Parrot Pot — Calibration
service (39e1fe00)" comment block (schema.prisma:396-398), a new migration
(`pnpm exec prisma migrate dev --name add_tank_capacity_raw` from `backend/`), read it in both
`mock`/`node-ble` providers using the exact same `readRawBestEffort` pattern already used for
`colorRaw`/`calibrationDataBlobHex` in `node-ble/index.ts` (lines ~784-812), and switch
`PlantAdviceTab`'s water card reservoir display from `${Math.round(waterTankLevelPercent)}%` to a
liters string using the confirmed conversion factor.

**If no hypothesis is conclusive** (device unreachable, value doesn't reconstruct any plausible real
capacity): make no code or schema change. Leave the reservoir display in percent (as already shipped
by Task 6). Record the raw value observed in a new `CLAUDE.md` entry under this sub-project's
description, so a future attempt doesn't re-read a value already known to be inconclusive without
context.

- [ ] **Step 5: Commit the script (and, if confirmed, the follow-up wiring) separately**

```bash
git add backend/scripts/hwtest-tank-capacity-8733.ts
git commit -m "hw: add fe05 (tank capacity) hardware verification script"
```

If Step 4 confirmed an encoding, commit that follow-up work as its own separate commit with a
message describing the confirmed encoding (e.g. "feat: read real tank capacity via 39e1FE05,
switch reservoir card to liters").

---

## Final review and CLAUDE.md update

Once all 8 tasks are complete: run `cd backend && pnpm exec tsc --noEmit && pnpm test` and
`cd frontend && pnpm typecheck` one more time from a clean checkout of the branch tip, then add a new
dated entry to `CLAUDE.md`'s "Project status (by batch)" section describing this sub-project
(structure mirrors every other entry there: what was built, key decisions — especially the verbatim
IP-risk acknowledgment, the Xiaomi `raw_no_species_support` edge case found during planning, the
fertilizer type-count logic, and Task 8's outcome — and what's verified vs. not), and update
`docs/superpowers/specs/2026-08-31-ui-overhaul-roadmap.md`'s "Suivi" checklist to mark sous-projet 3
done, matching how sous-projet 2 was closed out.
