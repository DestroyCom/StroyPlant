# Parrot Pot Live Sensor View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the water reservoir (in liters) to the existing live-sensor-mode view, and convert
every existing reservoir display (live view + the "Détails techniques" gauge) from percent to
liters — matching the official Parrot app.

**Architecture:** The reservoir's raw value is already a percent (`f907`, `waterTankLevelPercent`
on `ParrotPotReading` — already declared in the shared type, just never streamed live). This plan
(1) extends `subscribeLive()` on the real `node-ble` provider and the `mock` provider to also emit
`waterTankLevelPercent` in every live sample, seeded from a one-time read since the watering
service's tank characteristic doesn't notify anywhere near as often as the 1Hz live sensors and must
never block the live view waiting for it, and (2) adds a shared `tankLevelLiters()` conversion
helper used everywhere a reservoir value is displayed, replacing the raw percent.

**Tech Stack:** TypeScript, `node-ble`, React 19, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-08-31-parrot-pot-official-app-parity-design.md` (sections 5-6
only — sections 1-4, the watering mode system, are a separate plan,
`docs/superpowers/plans/2026-08-31-parrot-watering-mode-system.md`; the two plans don't depend on
each other and can be done in either order).

## Global Constraints

- `pnpm` exclusively, never `npm`/`yarn`.
- TypeScript everywhere, no Python.
- Never test the real BLE layer on Mac — use the `mock` provider for all verification in this plan.
  A real hardware confirmation of the `node-ble` change (Task 1) is a documented follow-up, not part
  of this plan's verification (matches this project's own precedent for `subscribeLive`'s node-ble
  branch, "not yet validated against real hardware" in `CLAUDE.md`'s "Live sensor mode" entry).
- The live session's existing 5-minute global cap, single-session-at-a-time lock, and debounced
  sample flush are untouched by this plan — only the *set of fields* in each flushed sample changes.
- Biome formatting (2 spaces, single quotes) — run `pnpm lint:fix` from the repo root before each
  commit if unsure.

---

### Task 1: `node-ble` provider — stream tank level in live sessions without blocking the other 3 metrics

**Files:**
- Modify: `backend/src/providers/node-ble/index.ts` (the `subscribeLive` method's Parrot Pot
  branch, currently lines 940-1057)

**Interfaces:**
- Consumes: `UUIDS.watering.waterTankLevel` (already exists, `'39e1f907-...'`),
  `WATERING_SERVICE_UUID` (already imported in this file for `triggerAction`), `trackedCharacteristic`
  (already used throughout this file).
- Produces: `onSample({ kind: 'PARROT_POT', data: { soilMoisturePercent, temperatureC, luminosity,
  waterTankLevelPercent } })` — `waterTankLevelPercent` is new on this call site;
  `ParrotPotReading`'s type (`backend/src/providers/types.ts`) already declares this field as
  optional, no type change needed there.

**Why this can't just be "add a 4th required field to the existing wait-for-complete-triple
gate"**: `f907` lives on the *watering* GATT service, not the *live* sensor service the other 3
fields notify on — it's a slow-changing value (the reservoir doesn't drain every second) that the
firmware may not notify again for the entire 5-minute session if the level doesn't change. The
existing code (`scheduleFlush`) waits for `pending.soilMoisturePercent`/`temperatureC`/`luminosity`
to all be defined before ever emitting a sample — doing the same for tank level would mean the
**entire live view silently never shows anything** if no tank-level notification happens to arrive
in that window. This task instead **reads the tank level once up front** (seeding `pending`
immediately) and updates it opportunistically via notify if it ever changes, but never adds it to
the required-before-first-flush set.

- [ ] **Step 1: Open the watering service and read the tank level once, before starting notifications**

In `backend/src/providers/node-ble/index.ts`, find this block inside `subscribeLive`'s Parrot Pot
branch (currently right after the `measurePeriod.writeValueWithResponse(...)` call and its `log(...)`):

```ts
        try {
          if (signal.aborted) return;

          const soilChar = await trackedCharacteristic(sensorService, UUIDS.live.soilMoisturePercent, characteristics);
          const tempChar = await trackedCharacteristic(sensorService, UUIDS.live.temperatureC, characteristics);
          const luxChar = await trackedCharacteristic(sensorService, UUIDS.live.luminosity, characteristics);
          if (signal.aborted) return;
```

Replace it with (adds the watering service + tank characteristic + a one-time seed read):

```ts
        try {
          if (signal.aborted) return;

          const soilChar = await trackedCharacteristic(sensorService, UUIDS.live.soilMoisturePercent, characteristics);
          const tempChar = await trackedCharacteristic(sensorService, UUIDS.live.temperatureC, characteristics);
          const luxChar = await trackedCharacteristic(sensorService, UUIDS.live.luminosity, characteristics);
          if (signal.aborted) return;

          // Tank level (f907) lives on the watering service, not the live sensor service above,
          // and doesn't notify at anywhere near the same 1Hz rate — it only changes when water is
          // actually dispensed. Read it once up front so every sample has a value from the start,
          // never gated on a notification that might not arrive all session — see this task's own
          // header comment for why waiting for it here would be a real bug, not just a nicety.
          const wateringService = await gatt.getPrimaryService(WATERING_SERVICE_UUID);
          const tankChar = await trackedCharacteristic(wateringService, UUIDS.watering.waterTankLevel, characteristics);
          if (signal.aborted) return;
          let latestTankLevel = (await tankChar.readValue()).readUInt8(0);
```

- [ ] **Step 2: Include the tank level in every snapshot, and update it opportunistically via notify**

Find the `scheduleFlush` closure's snapshot construction:

```ts
                  const snapshot = {
                    soilMoisturePercent: pending.soilMoisturePercent,
                    temperatureC: pending.temperatureC,
                    luminosity: pending.luminosity,
                  };
```

Replace with:

```ts
                  const snapshot = {
                    soilMoisturePercent: pending.soilMoisturePercent,
                    temperatureC: pending.temperatureC,
                    luminosity: pending.luminosity,
                    waterTankLevelPercent: latestTankLevel,
                  };
```

Then find the 3 notify handlers (`onSoil`/`onTemp`/`onLux`) and add a 4th right after `onLux`:

```ts
              const onTank = (buf: Buffer) => {
                latestTankLevel = buf.readUInt8(0);
                // Deliberately NOT calling scheduleFlush() here — a tank-level change alone
                // shouldn't force an out-of-cadence sample; the next soil/temp/lux-driven flush
                // (at most ~1s away) will already pick up this new value via `latestTankLevel`.
              };
```

Then find `cleanupListeners` and add the new listener's removal:

```ts
              const cleanupListeners = () => {
                soilChar.removeListener('valuechanged', onSoil);
                tempChar.removeListener('valuechanged', onTemp);
                luxChar.removeListener('valuechanged', onLux);
                tankChar.removeListener('valuechanged', onTank);
                if (flushTimer) clearTimeout(flushTimer);
                signal.removeEventListener('abort', onAbort);
                device.removeListener('disconnect', onDisconnect);
              };
```

Then find where the 3 existing listeners are registered and the notifications started, and add the
4th to both:

```ts
              soilChar.on('valuechanged', onSoil);
              tempChar.on('valuechanged', onTemp);
              luxChar.on('valuechanged', onLux);
              tankChar.on('valuechanged', onTank);
              signal.addEventListener('abort', onAbort, { once: true });
              device.once('disconnect', onDisconnect);
            });
          } finally {
            for (const characteristic of [soilChar, tempChar, luxChar, tankChar]) {
              await characteristic.stopNotifications().catch(() => {});
            }
          }
```

(That last `finally` block is the existing one right after the `new Promise<void>(...)` — add
`tankChar` to its array and, before this whole inner `try`, add `await tankChar.startNotifications();`
next to the existing 3 `startNotifications()` calls:

```ts
          await soilChar.startNotifications();
          await tempChar.startNotifications();
          await luxChar.startNotifications();
          await tankChar.startNotifications();
```

)

- [ ] **Step 3: Typecheck**

Run: `cd backend && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Run the backend test suite**

Run: `cd backend && npm run test`

Expected: all tests pass (this file has no dedicated automated test — matches this project's
established convention for the real BLE provider files, verified via the mock provider + manual
hardware follow-up instead).

- [ ] **Step 5: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/providers/node-ble/index.ts
git commit -m "feat(backend): stream tank level in Parrot Pot live sessions (node-ble)"
```

---

### Task 2: Mock provider — simulate tank level in live sessions

**Files:**
- Modify: `backend/src/providers/mock/index.ts` (`subscribeLive`, currently lines 252-316)

**Interfaces:**
- Consumes: `pot.waterTankLevelPercent` (already exists on the mock pot state, already read/written
  by this same file's `triggerAction`).
- Produces: same `onSample` shape as Task 1 — this task and Task 1 are independent, order doesn't
  matter, both must land before Task 4's manual verification.

- [ ] **Step 1: Add `waterTankLevelPercent` to the simulated Parrot Pot sample**

In `backend/src/providers/mock/index.ts`, find this line inside `subscribeLive`'s Parrot Pot branch:

```ts
                  await onSample({
                    kind: 'PARROT_POT',
                    data: { soilMoisturePercent: pot.soilMoisturePercent, temperatureC: pot.temperatureC, luminosity: pot.luminosity },
                  });
```

Replace with:

```ts
                  await onSample({
                    kind: 'PARROT_POT',
                    data: {
                      soilMoisturePercent: pot.soilMoisturePercent,
                      temperatureC: pot.temperatureC,
                      luminosity: pot.luminosity,
                      waterTankLevelPercent: pot.waterTankLevelPercent,
                    },
                  });
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Run the backend test suite**

Run: `cd backend && npm run test`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/providers/mock/index.ts
git commit -m "feat(backend): simulate tank level in mock provider live sessions"
```

---

### Task 3: Frontend — liters everywhere + tank level in the live view

**Files:**
- Modify: `frontend/src/lib/format.ts` (add the conversion helper)
- Modify: `frontend/src/components/sensor-gauge.tsx` (add a `decimals` prop, default unchanged)
- Modify: `frontend/src/components/live-mode-section.tsx` (add the reservoir metric with conversion)
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.tsx` (the "Détails techniques" tank
  gauge, currently around lines 385-388)

**Interfaces:**
- Consumes: `ParrotPotReading.waterTankLevelPercent` (already exists), Tasks 1-2's live samples.
- Produces: `tankLevelLiters(percent: number): number` in `format.ts`, used by both the gauge and
  the live view — nothing later depends on this beyond this task's own steps.

- [ ] **Step 1: Add the conversion helper to `format.ts`**

In `frontend/src/lib/format.ts`, add near the existing `LOW_TANK_THRESHOLD` constant:

```ts
// Real capacity confirmed from the official app's own UI (docs/flowerpower_screenshot/,
// "Réservoir d'eau : 2.1L" out of "2.2L"). The device only ever reports a percent (f907) — this
// is a pure display conversion, isTankLow's own threshold logic below stays on percent internally
// (no behavior change, just how the number is shown to a user).
const TANK_CAPACITY_LITERS = 2.2;

export function tankLevelLiters(percent: number): number {
  return (percent / 100) * TANK_CAPACITY_LITERS;
}
```

- [ ] **Step 2: Add a `decimals` prop to `SensorGauge`**

In `frontend/src/components/sensor-gauge.tsx`, the component currently always does
`Math.round(value)` — a whole-liter rounding would show "2L" for a 2.1L reading, losing exactly the
precision that makes liters meaningful. Change the props destructuring:

```ts
export function SensorGauge({
  label,
  value,
  max = 100,
  unit = '%',
  decimals = 0,
  tone = 'primary',
  icon,
  hint,
}: {
  label: string;
  value: number;
  max?: number;
  unit?: string;
  decimals?: number;
  tone?: keyof typeof TONE_VARS;
  icon?: ReactNode;
  hint?: string;
}) {
```

And change the rendered value:

```tsx
          <span className="text-sm font-bold text-foreground">
            {value.toFixed(decimals)}
            {unit}
          </span>
```

Every existing call site keeps its current whole-number display (default `decimals = 0` behaves
identically to the old `Math.round`), only the tank gauge (Step 4 below) opts into `decimals={1}`.

- [ ] **Step 3: Add the reservoir metric to the live view, converted to liters**

In `frontend/src/components/live-mode-section.tsx`:

1. Import the helper: add `tankLevelLiters` to the existing `import { ... } from '@/lib/format'`
   line — if no such import exists yet in this file, add a new one:
   `import { tankLevelLiters } from '@/lib/format';`

2. Extend `MetricSpec` with an optional transform, and add the reservoir entry to `PARROT_METRICS`:

```ts
interface MetricSpec {
  key: 'soilMoisturePercent' | 'temperatureC' | 'luminosity' | 'humidityPercent' | 'waterTankLevelPercent';
  label: string;
  unit: string;
  transform?: (raw: number) => number;
}

const PARROT_METRICS: MetricSpec[] = [
  { key: 'soilMoisturePercent', label: 'Humidité du sol', unit: '%' },
  { key: 'temperatureC', label: 'Température', unit: '°' },
  { key: 'luminosity', label: 'Luminosité (DLI)', unit: ' mol/m²/j' },
  { key: 'waterTankLevelPercent', label: 'Réservoir', unit: 'L', transform: tankLevelLiters },
];
```

3. Find where each sample's buffer is built (`setBuffers((prev) => { ... })`, the `for (const metric
   of metrics)` loop) and apply the transform:

```ts
          setBuffers((prev) => {
            const next = { ...prev };
            for (const metric of metrics) {
              const value = event.reading[metric.key];
              if (value == null) continue;
              const points = next[metric.key] ?? [];
              const displayValue = metric.transform ? metric.transform(value) : value;
              next[metric.key] = [...points, { timestamp: event.reading.timestamp, value: displayValue }].slice(-MAX_BUFFER_SIZE);
            }
            return next;
          });
```

Fertilizer/soil-conductivity is deliberately **not** added here — the spec (section 5) confirms the
official app itself shows "non disponible en mode live" for that value, matching the existing
`PARROT_METRICS` list already excluding it.

- [ ] **Step 4: Convert the "Détails techniques" tank gauge to liters**

In `frontend/src/routes/_authenticated/devices.$deviceId.tsx`, import `tankLevelLiters` from
`@/lib/format` (add to the existing import from that module, or add a new import line), then find:

```tsx
                  {reading.waterTankLevelPercent != null && (
                    <SensorGauge label="Réservoir" value={reading.waterTankLevelPercent} tone="accent" icon={<Droplets size={16} />} />
                  )}
```

Replace with:

```tsx
                  {reading.waterTankLevelPercent != null && (
                    <SensorGauge
                      label="Réservoir"
                      value={tankLevelLiters(reading.waterTankLevelPercent)}
                      max={2.2}
                      unit="L"
                      decimals={1}
                      tone="accent"
                      icon={<Droplets size={16} />}
                    />
                  )}
```

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 6: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && npx biome check --write frontend/src/lib/format.ts frontend/src/components/sensor-gauge.tsx frontend/src/components/live-mode-section.tsx frontend/src/routes/_authenticated/devices.\$deviceId.tsx`

Expected: clean or auto-fixed.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add frontend/src/lib/format.ts frontend/src/components/sensor-gauge.tsx frontend/src/components/live-mode-section.tsx "frontend/src/routes/_authenticated/devices.\$deviceId.tsx"
git commit -m "feat(frontend): show the water reservoir in liters, live view + gauges"
```

---

### Task 4: End-to-end verification against the mock provider

**Files:** none modified — manual verification, matching this project's established convention.

- [ ] **Step 1: Start the backend and frontend against the mock provider**

Run: `cd backend && BLE_PROVIDER=mock pnpm dev` (one terminal), `cd frontend && pnpm dev` (another).

- [ ] **Step 2: Open a mock Parrot Pot's detail page and check the "Détails techniques" gauge**

Sign in, open `MOCK-POT-NORMAL`'s detail page, expand "Détails techniques". Confirm the reservoir
gauge shows a value like "2.2L" (one decimal place) instead of a percent, and the ring fill still
looks proportionally correct (should be near-full for `MOCK-POT-NORMAL`).

- [ ] **Step 3: Start a live session and confirm the reservoir chart appears**

Click "Démarrer" on the "Mode live" section. Confirm a 4th chart labeled "Réservoir" appears
alongside "Humidité du sol"/"Température"/"Luminosité (DLI)", with values plotted in liters (e.g.
around 2.2, not 100).

- [ ] **Step 4: Trigger a watering while live and confirm the reservoir chart drops**

While the live session is still running, open a second browser tab to the same device (or use the
"Arroser maintenant" button on this same page if visible) and trigger a watering. Confirm the
reservoir chart's plotted value visibly drops within a few seconds (the mock's `applyPotDecay`/
`triggerAction` already reduces `pot.waterTankLevelPercent` — this just confirms it now reaches the
live chart, not just the polled reading).

- [ ] **Step 5: Confirm `MOCK-POT-DECLINE` (empty reservoir) shows ~0.0L, not a crash**

Open `MOCK-POT-DECLINE`'s detail page (starts with an empty reservoir per its mock design). Confirm
the "Détails techniques" gauge shows "0.0L" (not blank, not NaN, not a negative number) and, if you
start a live session there too, the reservoir chart starts at 0 rather than erroring.

- [ ] **Step 6: Confirm no regression on the other 3 live metrics**

While the live session from Step 3/4 is still running, confirm "Humidité du sol"/"Température"/
"Luminosité (DLI)" are still updating normally (this proves Task 1's tank-level addition didn't
accidentally gate the other 3 metrics on anything new — re-read Task 1's own reasoning if this
fails, it's the exact bug that task was written to avoid).

- [ ] **Step 7: Run the full test suite one more time to confirm nothing regressed**

Run: `cd backend && npx tsc --noEmit && npm run test` and `cd frontend && npx tsc --noEmit`

Expected: all clean.

- [ ] **Step 8: Report results to DestCom, flag the real-hardware follow-up**

Summarize what was verified (Steps 2-6). Explicitly note Task 1's `node-ble` change (the real
provider) has **not** been validated against real Parrot Pot hardware in this plan — same
"verified against mock, real-hardware confirmation pending" posture this project already uses for
every other `subscribeLive` change (see `CLAUDE.md`'s "Live sensor mode" entry) — recommend a real
live-session test on the production server the next time hardware is reachable.
