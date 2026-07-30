# Responsive layout + global history page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the whole StroyPlant frontend usable on a phone (Tailwind breakpoint-based responsive layout matching DestCom's wireframes), and build the global "Historique" page the mobile bottom nav points at — including a new persisted log of sync/BLE read failures that today only exist in console output.

**Architecture:** Pure-CSS responsive layout (Tailwind `md:` breakpoint classes only, no JS viewport hook) for every existing page. One new Prisma model (`SyncEvent`) captures sync failures; one new tRPC router (`history`) merges it with the existing `WateringEvent` table into a single sorted feed; one new frontend route (`/history`) renders it grouped by day.

**Tech Stack:** Fastify + Prisma/SQLite + tRPC (backend), Vite + React 19 + TanStack Router/Query + Tailwind v4 + shadcn/ui (frontend), pnpm workspace.

## Global Constraints

- `pnpm` exclusively, never `npm`/`yarn`.
- TypeScript everywhere, no JS.
- **No test framework exists in this repo** (no vitest/jest, `grep` confirms zero `*.test.ts`/`*.spec.ts` files) — every prior batch in this project was verified manually against the `mock` BLE provider (dev server + curl / a disposable `tsx` script), documented extensively in `CLAUDE.md`. This plan follows that same convention instead of introducing a test framework: pure-logic steps are checked with a throwaway `tsx` script (`node:assert`, deleted after use), and wiring/integration steps are checked by running the dev servers and hitting them with `curl` or a browser.
- Biome for lint/format (2 spaces, single quotes) — run `pnpm lint:fix` from the repo root after each task, before committing.
- All UI copy is in French, matching the existing app.
- Never silently swallow a BLE/sync error (`docs/STROYPLANT_SPEC.md` section 7.1) — this plan's `SyncEvent` persistence is *additive* to the existing `log(...)` console call at each site, never a replacement for it.
- Breakpoint: Tailwind's `md` (768px), matching the split already used in `frontend/src/routes/login.tsx`.
- No `Co-Authored-By` line in any commit (global rule).
- Commit after each task, following the repo's existing commit style (`git log` for reference) — but only once the task's own verification step passes.

---

## Task 1: `SyncEvent` Prisma model + migration

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Interfaces:**
- Produces: Prisma model `SyncEvent` (fields: `id: Int`, `deviceId: String`, `device: Device`, `timestamp: DateTime`, `source: SyncSource`, `errorDetail: String`) and enum `SyncSource { POLL, MANUAL }`, both available via `@prisma/client` after generation. `Device` gains a `syncEvents SyncEvent[]` relation field.

- [ ] **Step 1: Add the enum and model to schema.prisma**

Open `backend/prisma/schema.prisma`. Find the existing `TriggerSource`/`WateringEvent` block (currently around line 155-170):

```prisma
enum TriggerSource {
  MANUAL
  CRON
}

model WateringEvent {
  id            Int           @id @default(autoincrement())
  deviceId      String
  device        Device        @relation(fields: [deviceId], references: [id])
  timestamp     DateTime      @default(now())
  triggerSource TriggerSource
  success       Boolean
  errorDetail   String?

  @@index([deviceId, timestamp])
}
```

Add immediately after it:

```prisma
// A sync/read failure that today is only ever logged to the console (backend/src/ble/scanner.ts,
// backend/src/api/trpc/routers/devices.ts) — persisted so the global history page
// (docs/superpowers/specs/2026-07-30-responsive-and-global-history-design.md) can show them.
// Only failures are ever inserted: a successful sync already has a Reading row proving it
// happened, so persisting every success too would just duplicate that with no new information.
enum SyncSource {
  POLL // scanner's own throttled polling loop (ble/scanner.ts's pollDeviceNow)
  MANUAL // devices.sync / devices.forceSyncAll (user-triggered)
}

model SyncEvent {
  id          Int        @id @default(autoincrement())
  deviceId    String
  device      Device     @relation(fields: [deviceId], references: [id])
  timestamp   DateTime   @default(now())
  source      SyncSource
  errorDetail String

  @@index([deviceId, timestamp])
}
```

- [ ] **Step 2: Add the relation field on `Device`**

Find the `Device` model (currently lines 25-41), which ends with:

```prisma
  readings       Reading[]
  wateringEvents WateringEvent[]
  schedule       Schedule?
}
```

Change it to:

```prisma
  readings       Reading[]
  wateringEvents WateringEvent[]
  syncEvents     SyncEvent[]
  schedule       Schedule?
}
```

- [ ] **Step 3: Generate and run the migration**

Run from the repo root:

```bash
cd backend && pnpm run prisma:migrate -- --name add_sync_event
```

Expected: prompts complete non-interactively (the `--name` flag supplies the name), a new folder appears under `backend/prisma/migrations/` (e.g. `20260730..._add_sync_event/migration.sql`) containing `CREATE TABLE "SyncEvent" (...)`, and the command ends with "Your database is now in sync with your schema." `@prisma/client` is regenerated automatically as part of `prisma migrate dev`.

- [ ] **Step 4: Verify the generated client exposes the new model**

Run:

```bash
cd backend && grep -n "SyncEvent\|SyncSource" node_modules/.prisma/client/index.d.ts | head -5
```

Expected: matches for both `SyncEvent` and `SyncSource` in the generated type definitions.

- [ ] **Step 5: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "Add SyncEvent model to persist sync/BLE read failures"
```

---

## Task 2: Persist sync failures at their 3 existing catch sites

**Files:**
- Modify: `backend/src/readings.ts`
- Modify: `backend/src/ble/scanner.ts`
- Modify: `backend/src/api/trpc/routers/devices.ts`

**Interfaces:**
- Consumes: `SyncEvent`/`SyncSource` from `@prisma/client` (Task 1), `prisma` client from `backend/src/db/client.js`.
- Produces: `persistSyncFailure(deviceId: string, source: SyncSource, errorDetail: string): Promise<void>`, exported from `backend/src/readings.ts`, used by Task 3's verification and by the 2 call sites below.

- [ ] **Step 1: Add `persistSyncFailure` to `readings.ts`**

Open `backend/src/readings.ts`. Add this import at the top (next to the existing `ReadingSource` import):

```ts
import type { ReadingSource, SyncSource } from '@prisma/client';
```

Add this function at the end of the file, after `persistReading`:

```ts
// Additive to the existing console `log(...)` call at each of its 3 call sites (scanner.ts's
// pollDeviceNow, devices.ts's sync/forceSyncAll) — never a replacement for it (docs/STROYPLANT_SPEC.md
// section 7.1). A successful sync is never recorded here: the resulting Reading row already proves
// it happened, so only failures are persisted.
export async function persistSyncFailure(deviceId: string, source: SyncSource, errorDetail: string) {
  await prisma.syncEvent.create({ data: { deviceId, source, errorDetail } });
}
```

- [ ] **Step 2: Verify with a throwaway script**

Create `/private/tmp/claude-501/-Users-destcom-Documents-PERSO-StroyPlant/14a397a8-1ef5-4630-9ea2-6cbc629ad2ba/scratchpad/verify-sync-failure.ts`:

```ts
import assert from 'node:assert';
import { prisma } from '../../../../../../../Users/destcom/Documents/PERSO/StroyPlant/backend/src/db/client.js';
import { persistSyncFailure } from '../../../../../../../Users/destcom/Documents/PERSO/StroyPlant/backend/src/readings.js';

const deviceId = 'VERIFY-SYNC-EVENT';
await prisma.device.upsert({ where: { id: deviceId }, create: { id: deviceId, kind: 'PARROT_POT' }, update: {} });

await persistSyncFailure(deviceId, 'POLL', 'test failure detail');
const row = await prisma.syncEvent.findFirst({ where: { deviceId }, orderBy: { timestamp: 'desc' } });
assert(row, 'expected a SyncEvent row to be created');
assert.strictEqual(row.source, 'POLL');
assert.strictEqual(row.errorDetail, 'test failure detail');
console.log('PASS');

// cleanup
await prisma.syncEvent.deleteMany({ where: { deviceId } });
await prisma.device.delete({ where: { id: deviceId } });
await prisma.$disconnect();
```

Run it from `backend/` (so the relative import path above resolves — adjust the `../../...` prefix to whatever actually points at `backend/src` from the scratchpad directory, or simpler: copy the script's two imported lines' logic inline and run with `cd backend && pnpm exec tsx <path-to-script>`):

```bash
cd backend && pnpm exec tsx /private/tmp/claude-501/-Users-destcom-Documents-PERSO-StroyPlant/14a397a8-1ef5-4630-9ea2-6cbc629ad2ba/scratchpad/verify-sync-failure.ts
```

Expected output: `PASS`. Delete the script afterward (`rm` it) — it's a throwaway check, not part of the codebase.

- [ ] **Step 3: Wire into `scanner.ts`'s `pollDeviceNow`**

Open `backend/src/ble/scanner.ts`. Add the import:

```ts
import { persistSyncFailure } from '../readings.js';
```

Find `pollDeviceNow`'s catch block (currently lines 43-51):

```ts
      } catch (error) {
        // Never swallow an error silently (docs/STROYPLANT_SPEC.md section 7.1).
        log({
          direction: 'READ',
          label: 'Poll readSensors failed',
          deviceId,
          result: 'ERROR',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
```

Change it to:

```ts
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // Never swallow an error silently (docs/STROYPLANT_SPEC.md section 7.1).
        log({
          direction: 'READ',
          label: 'Poll readSensors failed',
          deviceId,
          result: 'ERROR',
          detail,
        });
        await persistSyncFailure(deviceId, 'POLL', detail).catch((persistError) => {
          log({
            direction: 'INFO',
            label: 'persistSyncFailure failed',
            deviceId,
            result: 'ERROR',
            detail: persistError instanceof Error ? persistError.message : String(persistError),
          });
        });
      }
```

- [ ] **Step 4: Wire into `devices.ts`'s `sync` mutation**

Open `backend/src/api/trpc/routers/devices.ts`. Add the import:

```ts
import { persistReading, persistSyncFailure } from '../../../readings.js';
```

(This replaces the existing `import { persistReading } from '../../../readings.js';` line.)

Find the `sync` mutation's catch block (currently lines 137-142):

```ts
    let reading: Awaited<ReturnType<typeof ctx.provider.readSensors>>;
    try {
      reading = await ctx.connectionQueue.run(() => ctx.provider.readSensors(device.id, device.kind));
    } catch (error) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: error instanceof Error ? error.message : String(error) });
    }
```

Change it to:

```ts
    let reading: Awaited<ReturnType<typeof ctx.provider.readSensors>>;
    try {
      reading = await ctx.connectionQueue.run(() => ctx.provider.readSensors(device.id, device.kind));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await persistSyncFailure(device.id, 'MANUAL', detail);
      throw new TRPCError({ code: 'BAD_GATEWAY', message: detail });
    }
```

- [ ] **Step 5: Wire into `devices.ts`'s `forceSyncAll` mutation**

Find `forceSyncAll`'s catch block (currently lines 163-172):

```ts
        .catch((error) => {
          log({
            direction: 'READ',
            label: 'Forced sync readSensors failed',
            deviceId: device.id,
            result: 'ERROR',
            detail: error instanceof Error ? error.message : String(error),
          });
        });
```

Change it to:

```ts
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          log({
            direction: 'READ',
            label: 'Forced sync readSensors failed',
            deviceId: device.id,
            result: 'ERROR',
            detail,
          });
          void persistSyncFailure(device.id, 'MANUAL', detail);
        });
```

- [ ] **Step 6: Verify end-to-end against the mock provider**

Start the backend dev server pointed at the mock provider (check `backend/.env` for `PROVIDER=mock` — this is the existing dev default, confirm rather than assume):

```bash
cd backend && pnpm dev
```

In another terminal, trigger a manual sync against a device id the mock provider doesn't recognize, which forces `readSensors` to throw:

```bash
# sign in first to get a session cookie (use the existing dev admin from `pnpm seed:admin`, or seed
# one temporarily — DestCom's ADMIN_EMAIL/ADMIN_PASSWORD from backend/.env)
curl -c /tmp/sp-cookies.txt -s -X POST http://localhost:3000/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | head -c 200

curl -b /tmp/sp-cookies.txt -s -X POST http://localhost:3000/api/trpc/devices.sync \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"NONEXISTENT-DEVICE"}'
```

Expected: the HTTP response is a tRPC error (`BAD_GATEWAY`-shaped body), and the server log shows both the existing `Poll readSensors failed`/`sync` error log AND no unhandled promise rejection. Then confirm the row landed:

```bash
cd backend && pnpm exec tsx -e "
import('./src/db/client.js').then(async ({ prisma }) => {
  const rows = await prisma.syncEvent.findMany({ where: { deviceId: 'NONEXISTENT-DEVICE' } });
  console.log(rows);
  await prisma.syncEvent.deleteMany({ where: { deviceId: 'NONEXISTENT-DEVICE' } });
  await prisma.\$disconnect();
});
"
```

Expected: one row printed with `source: 'MANUAL'` and a non-empty `errorDetail`, then cleaned up by the same script. Remove `/tmp/sp-cookies.txt` afterward.

- [ ] **Step 7: Commit**

```bash
git add backend/src/readings.ts backend/src/ble/scanner.ts backend/src/api/trpc/routers/devices.ts
git commit -m "Persist sync/BLE read failures as SyncEvent rows"
```

---

## Task 3: `history` tRPC router — merges `WateringEvent` + `SyncEvent`

**Files:**
- Modify: `backend/src/api/trpc/serialize.ts`
- Create: `backend/src/api/trpc/routers/history.ts`
- Modify: `backend/src/api/trpc/router.ts`

**Interfaces:**
- Consumes: `prisma` client, `protectedProcedure`/`router` from `../trpc.js`, `serializeDate` from `../serialize.js`.
- Produces: `historyRouter` mounted as `appRouter.history`, with one procedure `list(input: { deviceId?: string; days?: number }): HistoryEntry[]`. Also exports the pure function `mergeAndSortHistoryEntries(entries: HistoryEntry[]): HistoryEntry[]` and the `HistoryEntry` type, both from `history.ts`, for Task 3's own verification.

- [ ] **Step 1: Write `history.ts`**

Create `backend/src/api/trpc/routers/history.ts`:

```ts
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { serializeDate } from '../serialize.js';
import { protectedProcedure, router } from '../trpc.js';

// Common shape both WateringEvent (existing, both success and failure rows already) and SyncEvent
// (Task 1/2, failure-only) get mapped into, so the frontend renders one unified feed
// (docs/superpowers/specs/2026-07-30-responsive-and-global-history-design.md).
export interface HistoryEntry {
  id: string; // `watering-${id}` / `sync-${id}` — never collides as a React key across the 2 tables
  type: 'WATERING' | 'SYNC';
  deviceId: string;
  deviceName: string;
  timestamp: string;
  success: boolean; // SyncEvent rows are always false — see Task 1's model comment
  triggerLabel: 'MANUAL' | 'CRON' | 'POLL';
  errorDetail: string | null;
}

const HISTORY_LIMIT = 200;

// Exported standalone so it can be verified with fixture data, without touching the database.
export function mergeAndSortHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export const historyRouter = router({
  list: protectedProcedure.input(z.object({ deviceId: z.string().optional(), days: z.number().optional() })).query(async ({ input }) => {
    const since = input.days != null ? new Date(Date.now() - input.days * 24 * 60 * 60 * 1000) : undefined;
    const deviceFilter = input.deviceId ? { deviceId: input.deviceId } : {};
    const timeFilter = since ? { timestamp: { gte: since } } : {};

    const [wateringEvents, syncEvents] = await Promise.all([
      prisma.wateringEvent.findMany({
        where: { ...deviceFilter, ...timeFilter },
        include: { device: { select: { name: true } } },
        orderBy: { timestamp: 'desc' },
        take: HISTORY_LIMIT,
      }),
      prisma.syncEvent.findMany({
        where: { ...deviceFilter, ...timeFilter },
        include: { device: { select: { name: true } } },
        orderBy: { timestamp: 'desc' },
        take: HISTORY_LIMIT,
      }),
    ]);

    const entries: HistoryEntry[] = [
      ...wateringEvents.map(
        (event): HistoryEntry => ({
          id: `watering-${event.id}`,
          type: 'WATERING',
          deviceId: event.deviceId,
          deviceName: event.device.name ?? event.deviceId,
          timestamp: serializeDate(event.timestamp),
          success: event.success,
          triggerLabel: event.triggerSource,
          errorDetail: event.errorDetail,
        }),
      ),
      ...syncEvents.map(
        (event): HistoryEntry => ({
          id: `sync-${event.id}`,
          type: 'SYNC',
          deviceId: event.deviceId,
          deviceName: event.device.name ?? event.deviceId,
          timestamp: serializeDate(event.timestamp),
          success: false,
          triggerLabel: event.source,
          errorDetail: event.errorDetail,
        }),
      ),
    ];

    return mergeAndSortHistoryEntries(entries).slice(0, HISTORY_LIMIT);
  }),
});
```

Note: `serializeDate` is already exported from `serialize.ts` (no change needed there — Step 1's file list mention of `serialize.ts` is covered by this reuse, not a new export; skip modifying it).

- [ ] **Step 2: Verify `mergeAndSortHistoryEntries` with fixture data**

Create a throwaway script (adjust path to your scratchpad), e.g. `backend/scratch-verify-merge.ts`:

```ts
import assert from 'node:assert';
import { mergeAndSortHistoryEntries } from './src/api/trpc/routers/history.js';
import type { HistoryEntry } from './src/api/trpc/routers/history.js';

const fixture: HistoryEntry[] = [
  { id: 'watering-1', type: 'WATERING', deviceId: 'A', deviceName: 'A', timestamp: '2026-07-28T08:00:00.000Z', success: true, triggerLabel: 'CRON', errorDetail: null },
  { id: 'sync-1', type: 'SYNC', deviceId: 'B', deviceName: 'B', timestamp: '2026-07-29T08:00:00.000Z', success: false, triggerLabel: 'POLL', errorDetail: 'boom' },
  { id: 'watering-2', type: 'WATERING', deviceId: 'A', deviceName: 'A', timestamp: '2026-07-30T08:00:00.000Z', success: false, triggerLabel: 'MANUAL', errorDetail: 'reservoir empty' },
];

const sorted = mergeAndSortHistoryEntries(fixture);
assert.deepStrictEqual(sorted.map((e) => e.id), ['watering-2', 'sync-1', 'watering-1']);
console.log('PASS');
```

Run:

```bash
cd backend && pnpm exec tsx scratch-verify-merge.ts && rm scratch-verify-merge.ts
```

Expected: `PASS`, then the script is deleted.

- [ ] **Step 3: Mount the router**

Open `backend/src/api/trpc/router.ts`. Add the import and the router entry:

```ts
import { devicesRouter } from './routers/devices.js';
import { healthRouter } from './routers/health.js';
import { historyRouter } from './routers/history.js';
import { liveSessionRouter } from './routers/liveSession.js';
import { mqttRouter } from './routers/mqtt.js';
import { plantDrRouter } from './routers/plantDr.js';
import { readingsRouter } from './routers/readings.js';
import { scheduleRouter } from './routers/schedule.js';
import { router } from './trpc.js';

export const appRouter = router({
  devices: devicesRouter,
  health: healthRouter,
  history: historyRouter,
  liveSession: liveSessionRouter,
  mqtt: mqttRouter,
  plantDr: plantDrRouter,
  readings: readingsRouter,
  schedule: scheduleRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 4: Verify `history.list` end-to-end via curl**

With the dev server running (`cd backend && pnpm dev`) and a session cookie (reuse the sign-in curl from Task 2 Step 6):

```bash
curl -b /tmp/sp-cookies.txt -s "http://localhost:3000/api/trpc/history.list?input=%7B%7D" | head -c 2000
```

Expected: a JSON body with a `result.data` array — every existing `WateringEvent` in the dev DB (from prior manual testing, per `CLAUDE.md`) shows up with `type: "WATERING"`, and the `SyncEvent` row you may still have from Task 2 (if not yet cleaned up) shows with `type: "SYNC"`. Also check filtering:

```bash
curl -b /tmp/sp-cookies.txt -s "http://localhost:3000/api/trpc/history.list?input=%7B%22days%22%3A7%7D" | head -c 2000
```

Expected: only entries within the last 7 days. Remove `/tmp/sp-cookies.txt` when done.

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/trpc/routers/history.ts backend/src/api/trpc/router.ts
git commit -m "Add history tRPC router merging WateringEvent and SyncEvent"
```

---

## Task 4: Frontend types + day-bucket grouping helper

**Files:**
- Modify: `frontend/src/lib/types.ts`
- Modify: `frontend/src/lib/format.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `HistoryEntry` type (mirrors Task 3's backend shape) from `types.ts`; `dayBucketLabel(iso: string): string` from `format.ts`, used by Task 5.

- [ ] **Step 1: Add `HistoryEntry` to `types.ts`**

Open `frontend/src/lib/types.ts`. Add at the end of the file, after `WateringEvent`:

```ts
export interface HistoryEntry {
  id: string;
  type: 'WATERING' | 'SYNC';
  deviceId: string;
  deviceName: string;
  timestamp: string;
  success: boolean;
  triggerLabel: 'MANUAL' | 'CRON' | 'POLL';
  errorDetail: string | null;
}
```

- [ ] **Step 2: Add `dayBucketLabel` to `format.ts`**

Open `frontend/src/lib/format.ts`. Add at the end of the file:

```ts
// Calendar-day grouping heading for the history page ("Aujourd'hui" / "Hier" / "Il y a N jours") —
// distinct from formatRelativeTime above, which measures elapsed hours/days from now rather than
// calendar-day boundaries, so it can't tell "yesterday at 23:59" from "today at 00:01".
export function dayBucketLabel(iso: string): string {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) return "Aujourd'hui";
  if (diffDays === 1) return 'Hier';
  return `Il y a ${diffDays} jours`;
}
```

- [ ] **Step 3: Verify with a throwaway script**

Create `frontend/scratch-verify-daybucket.ts`:

```ts
import assert from 'node:assert';
import { dayBucketLabel } from './src/lib/format';

const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10).toISOString();
const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 10).toISOString();
const sixDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 10).toISOString();

assert.strictEqual(dayBucketLabel(today), "Aujourd'hui");
assert.strictEqual(dayBucketLabel(yesterday), 'Hier');
assert.strictEqual(dayBucketLabel(sixDaysAgo), 'Il y a 6 jours');
console.log('PASS');
```

Run:

```bash
cd frontend && pnpm exec tsx scratch-verify-daybucket.ts && rm scratch-verify-daybucket.ts
```

Expected: `PASS`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/lib/format.ts
git commit -m "Add HistoryEntry type and dayBucketLabel grouping helper"
```

---

## Task 5: `/history` frontend page

**Files:**
- Create: `frontend/src/routes/_authenticated/history.tsx`

**Interfaces:**
- Consumes: `trpc.history.list.queryOptions({ deviceId?, days? })` (Task 3), `trpc.devices.list.queryOptions()` (existing), `HistoryEntry` type + `dayBucketLabel` (Task 4), `Tabs`/`TabsList`/`TabsTrigger` (existing `ui/tabs.tsx`).
- Produces: route `/history`, linked from Task 6's `AppShell`.

- [ ] **Step 1: Write the page**

Create `frontend/src/routes/_authenticated/history.tsx`:

```tsx
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, ChevronDown, Droplets } from 'lucide-react';
import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { dayBucketLabel } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import type { HistoryEntry } from '@/lib/types';
import { cn } from '@/lib/utils';

type Period = 'all' | '7' | '30';
const PERIOD_DAYS: Record<Period, number | undefined> = { all: undefined, '7': 7, '30': 30 };

export const Route = createFileRoute('/_authenticated/history')({
  loader: ({ context }) => context.queryClient.ensureQueryData(trpc.devices.list.queryOptions()),
  component: HistoryPage,
});

interface DayGroup {
  label: string;
  entries: HistoryEntry[];
}

// Entries arrive pre-sorted desc from history.list, so consecutive same-day entries always end up
// adjacent — no need to re-sort here, just fold them into buckets in a single pass.
function groupByDay(entries: HistoryEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const label = dayBucketLabel(entry.timestamp);
    const last = groups.at(-1);
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

function entryLabel(entry: HistoryEntry): string {
  if (entry.type === 'WATERING') {
    if (entry.success) return `${entry.deviceName} a été arrosé${entry.triggerLabel === 'CRON' ? ' automatiquement' : ' à la main'}`;
    return `Échec de l'arrosage de ${entry.deviceName}`;
  }
  const sourceLabel = entry.triggerLabel === 'POLL' ? 'automatique' : 'manuelle';
  return `Échec de synchro (${sourceLabel}) sur ${entry.deviceName}`;
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const failed = !entry.success;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          failed ? 'bg-destructive/10 text-destructive' : 'bg-teal-100 text-teal-700',
        )}
      >
        {entry.type === 'WATERING' ? <Droplets size={14} /> : <AlertTriangle size={14} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{entryLabel(entry)}</div>
        {failed && entry.errorDetail && <div className="mt-0.5 text-xs wrap-break-word text-muted-foreground">{entry.errorDetail}</div>}
      </div>
      <div className="shrink-0 text-xs text-muted-foreground">
        {new Date(entry.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  );
}

function HistoryPage() {
  const { data: devices } = useSuspenseQuery(trpc.devices.list.queryOptions());
  const [deviceId, setDeviceId] = useState('');
  const [period, setPeriod] = useState<Period>('all');
  const { data: entries } = useQuery(trpc.history.list.queryOptions({ deviceId: deviceId || undefined, days: PERIOD_DAYS[period] }));
  const groups = entries ? groupByDay(entries) : [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-[22px] leading-tight font-black tracking-tight text-foreground md:text-[30px]">Journal d'arrosage</h1>
      </div>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:w-56">
          <select
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
            className="h-9 w-full appearance-none rounded-lg border border-input bg-transparent px-3 pr-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="">Toutes les plantes</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name ?? device.id}
              </option>
            ))}
          </select>
          <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground" />
        </div>

        <Tabs value={period} onValueChange={(value) => setPeriod(value as Period)}>
          <TabsList>
            <TabsTrigger value="all">Tout</TabsTrigger>
            <TabsTrigger value="7">7 jours</TabsTrigger>
            <TabsTrigger value="30">30 jours</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun événement pour cette période.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.label}</div>
              <div className="flex flex-col gap-2">
                {group.entries.map((entry) => (
                  <HistoryRow key={entry.id} entry={entry} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Regenerate the route tree and typecheck**

```bash
cd frontend && pnpm dev &
sleep 3 && kill %1
pnpm typecheck
```

Expected: `pnpm dev` (briefly started so `@tanstack/router-plugin` regenerates `src/routeTree.gen.ts` with the new `/history` route) exits cleanly when killed, and `pnpm typecheck` reports no errors.

- [ ] **Step 3: Manual verification**

With both dev servers running (`cd backend && pnpm dev`, `cd frontend && pnpm dev`), sign in at `http://localhost:5173/login` and navigate directly to `http://localhost:5173/history` (no nav link points at it yet — that's Task 6). Expected: the device dropdown lists your named devices, the Tout/7 jours/30 jours pills change the displayed set, entries are grouped under "Aujourd'hui"/"Hier"/etc. headings, and any `SyncEvent`/failed `WateringEvent` rows show in the destructive (red-tinted) styling with their full error text.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/routes/_authenticated/history.tsx frontend/src/routeTree.gen.ts
git commit -m "Add global history page"
```

---

## Task 6: `AppShell` responsive layout — sidebar/mobile header/bottom nav

**Files:**
- Modify: `frontend/src/components/app-shell.tsx`

**Interfaces:**
- Consumes: `logo` asset (`@/assets/logo.svg`), `Clock` icon from `lucide-react` (new import).
- Produces: no interface change — `AppShell` still takes `{ children: ReactNode }`.

- [ ] **Step 1: Rewrite `app-shell.tsx`**

Replace the full contents of `frontend/src/components/app-shell.tsx` with:

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Clock, Home, LogOut, PlusCircle, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import logo from '@/assets/logo.svg';
import { authClient } from '@/lib/auth-client';
import { useLiveReadings } from '@/lib/use-live-readings';
import { cn } from '@/lib/utils';

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useLiveReadings(queryClient);

  async function handleLogout() {
    await authClient.signOut();
    await navigate({ to: '/login' });
  }

  return (
    <div className="flex h-svh flex-col overflow-hidden md:flex-row">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-sidebar-border bg-sidebar px-4 py-3 text-sidebar-foreground md:hidden">
        <img src={logo} alt="" className="h-6.5 w-6.5" />
        <span className="text-[17px] font-black tracking-tight">StroyPlant</span>
      </header>

      <aside className="hidden w-54 shrink-0 flex-col gap-7 overflow-y-auto border-r border-sidebar-border bg-sidebar px-4 py-6 text-sidebar-foreground md:flex">
        <div className="flex items-center gap-2.5 px-2">
          <img src={logo} alt="" className="h-6.5 w-6.5" />
          <span className="text-[17px] font-black tracking-tight">StroyPlant</span>
        </div>
        <nav className="flex flex-col gap-1">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent',
              'data-[status=active]:font-bold data-[status=active]:text-sidebar-foreground [&[data-status=active]_svg]:text-sidebar-accent-foreground',
            )}
          >
            <Home size={18} />
            Tableau de bord
          </Link>
          <Link
            to="/history"
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent',
              'data-[status=active]:font-bold data-[status=active]:text-sidebar-foreground [&[data-status=active]_svg]:text-sidebar-accent-foreground',
            )}
          >
            <Clock size={18} />
            Historique
          </Link>
          <Link
            to="/devices/add"
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent',
              'data-[status=active]:font-bold data-[status=active]:text-sidebar-foreground [&[data-status=active]_svg]:text-sidebar-accent-foreground',
            )}
          >
            <PlusCircle size={18} />
            Ajouter un appareil
          </Link>
          <Link
            to="/settings"
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent',
              'data-[status=active]:font-bold data-[status=active]:text-sidebar-foreground [&[data-status=active]_svg]:text-sidebar-accent-foreground',
            )}
          >
            <Settings size={18} />
            Réglages
          </Link>
        </nav>
        <div className="mt-auto rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
          Clique sur un appareil pour voir son détail et son historique.
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent"
        >
          <LogOut size={16} />
          Se déconnecter
        </button>
      </aside>

      <main className="flex-1 overflow-y-auto bg-background p-4 pb-20 md:p-10 md:pb-10">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-sidebar-border bg-sidebar py-2 md:hidden">
        <Link
          to="/"
          activeOptions={{ exact: true }}
          className={cn(
            'flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] font-medium text-sidebar-foreground/70',
            'data-[status=active]:font-bold data-[status=active]:text-sidebar-accent-foreground',
          )}
        >
          <Home size={20} />
          Plantes
        </Link>
        <Link
          to="/history"
          className={cn(
            'flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] font-medium text-sidebar-foreground/70',
            'data-[status=active]:font-bold data-[status=active]:text-sidebar-accent-foreground',
          )}
        >
          <Clock size={20} />
          Historique
        </Link>
        <Link
          to="/settings"
          className={cn(
            'flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] font-medium text-sidebar-foreground/70',
            'data-[status=active]:font-bold data-[status=active]:text-sidebar-accent-foreground',
          )}
        >
          <Settings size={20} />
          Réglages
        </Link>
      </nav>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd frontend && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: Manual verification in a resized browser**

With both dev servers running, open `http://localhost:5173/` in Chrome/Firefox, open devtools, toggle device toolbar to a ~375px-wide viewport. Expected:
- The desktop sidebar is gone; a compact header with the logo + "StroyPlant" is at the top.
- A 3-tab bar (Plantes/Historique/Réglages) is fixed at the bottom, doesn't overlap page content, and correctly highlights the active tab while navigating between `/`, `/history`, `/settings`.
- Resizing back above 768px restores the original sidebar layout exactly as before (no visual regression at desktop width).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/app-shell.tsx
git commit -m "Make AppShell responsive: mobile header + bottom tab nav below md"
```

---

## Task 7: Login page — mobile header + desktop hero logo/wordmark

**Files:**
- Modify: `frontend/src/routes/login.tsx`

**Interfaces:**
- Consumes: `logo` (`@/assets/logo.svg`, colored, for the light mobile header) and `logoMonoLight` (`@/assets/logo-mono-light.svg`, light-on-dark variant, for the dark hero panel — already in the repo, unused until now).

- [ ] **Step 1: Add the imports**

Open `frontend/src/routes/login.tsx`. Add near the top, after the other imports:

```tsx
import logo from '@/assets/logo.svg';
import logoMonoLight from '@/assets/logo-mono-light.svg';
```

- [ ] **Step 2: Add the logo + wordmark to the desktop hero panel**

Find (currently lines 45-51):

```tsx
      <div className="relative hidden flex-1 flex-col items-center justify-center overflow-hidden bg-[linear-gradient(160deg,var(--color-teal-700),var(--color-teal-500))] p-16 text-center text-white md:flex">
        <div className="mb-7 flex h-30 w-30 items-center justify-center rounded-full bg-white/12">
          <Leaf size={60} strokeWidth={1.6} />
        </div>
        <h2 className="max-w-sm text-4xl font-black tracking-tight">Content de te revoir</h2>
        <p className="mt-3 max-w-sm text-lg text-paper-400">Tes plantes t'attendent. Connecte-toi pour prendre de leurs nouvelles.</p>
      </div>
```

Change it to:

```tsx
      <div className="relative hidden flex-1 flex-col items-center justify-center overflow-hidden bg-[linear-gradient(160deg,var(--color-teal-700),var(--color-teal-500))] p-16 text-center text-white md:flex">
        <div className="mb-6 flex items-center gap-2.5">
          <img src={logoMonoLight} alt="" className="h-7 w-7" />
          <span className="text-lg font-black tracking-tight">StroyPlant</span>
        </div>
        <div className="mb-7 flex h-30 w-30 items-center justify-center rounded-full bg-white/12">
          <Leaf size={60} strokeWidth={1.6} />
        </div>
        <h2 className="max-w-sm text-4xl font-black tracking-tight">Content de te revoir</h2>
        <p className="mt-3 max-w-sm text-lg text-paper-400">Tes plantes t'attendent. Connecte-toi pour prendre de leurs nouvelles.</p>
      </div>
```

- [ ] **Step 3: Add the compact mobile header above the form**

Find the entire second half of the component (currently lines 52-91, from the form's wrapper `div` to the end of the file):

```tsx
      <div className="flex flex-1 items-center justify-center p-10">
        <form className="flex w-full max-w-sm flex-col gap-5" onSubmit={handleSubmit}>
          <div>
            <h1 className="text-[26px] font-black tracking-tight text-foreground">Se connecter</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">C'est juste toi et tes plantes ici.</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={emailId}>Adresse email</Label>
            <Input
              id={emailId}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="toi@exemple.com"
              className="h-10"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={passwordId}>Mot de passe</Label>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              className="h-10"
            />
          </div>
          <Button type="submit" size="lg" disabled={pending} className="mt-1 h-11">
            {pending ? 'Connexion…' : 'Se connecter'}
          </Button>
        </form>
      </div>
    </div>
  );
}
```

Replace it with (only the outer wrapper's className and the new header block above `<form>` change — everything inside `<form>` is unchanged, copied verbatim so no field is lost):

```tsx
      <div className="flex flex-1 flex-col items-center justify-center gap-8 p-6 md:p-10">
        <div className="flex items-center gap-2 md:hidden">
          <img src={logo} alt="" className="h-6.5 w-6.5" />
          <span className="text-[17px] font-black tracking-tight text-foreground">StroyPlant</span>
        </div>
        <form className="flex w-full max-w-sm flex-col gap-5" onSubmit={handleSubmit}>
          <div>
            <h1 className="text-[26px] font-black tracking-tight text-foreground">Se connecter</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">C'est juste toi et tes plantes ici.</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={emailId}>Adresse email</Label>
            <Input
              id={emailId}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="toi@exemple.com"
              className="h-10"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={passwordId}>Mot de passe</Label>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              className="h-10"
            />
          </div>
          <Button type="submit" size="lg" disabled={pending} className="mt-1 h-11">
            {pending ? 'Connexion…' : 'Se connecter'}
          </Button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
cd frontend && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Manual verification**

Open `http://localhost:5173/login` at desktop width: hero panel now shows the logo + "StroyPlant" above the leaf icon. Resize to ~375px: hero panel disappears (unchanged behavior), and a compact logo + "StroyPlant" row appears above the "Se connecter" heading.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/login.tsx
git commit -m "Add logo/wordmark to login hero panel and a compact mobile header"
```

---

## Task 8: Settings "Ajouter un appareil" entry + remaining page responsive tweaks

**Files:**
- Modify: `frontend/src/routes/_authenticated/settings.tsx`
- Modify: `frontend/src/routes/_authenticated/index.tsx`
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.tsx`
- Modify: `frontend/src/routes/_authenticated/devices.add.tsx`
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.calibration.tsx`

**Interfaces:** none — purely visual/class changes, no new exports or props.

- [ ] **Step 1: Add the "Ajouter un appareil" card to Settings**

Open `frontend/src/routes/_authenticated/settings.tsx`. Add the import:

```tsx
import { PlusCircle } from 'lucide-react';
```

Find the "Compte" `Card` (lines 44-49) and insert a new card right after it, before the "Arrosage automatique" card:

```tsx
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Ajouter un appareil</CardTitle>
                <CardDescription>Réclamer un capteur détecté par le scanner BLE.</CardDescription>
              </div>
              <Link to="/devices/add">
                <Button variant="outline" size="sm">
                  <PlusCircle size={14} />
                  Ajouter
                </Button>
              </Link>
            </div>
          </CardHeader>
        </Card>
```

This needs the `Button` import too — add `import { Button } from '@/components/ui/button';` alongside the existing imports (the `Link` import already exists in this file).

- [ ] **Step 2: Dashboard header stacking on mobile**

Open `frontend/src/routes/_authenticated/index.tsx`. Find (currently lines 51-66):

```tsx
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <div className="mb-1.5 text-sm font-medium text-muted-foreground">Bonjour !</div>
          <h1 className="text-[30px] leading-tight font-black tracking-tight text-foreground">{summarySentence(devices)}</h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-1 shrink-0"
          disabled={forceSyncMutation.isPending || devices.length === 0}
          onClick={() => forceSyncMutation.mutate()}
        >
          <RefreshCw size={14} className={forceSyncMutation.isPending ? 'animate-spin' : undefined} />
          Forcer la synchro
        </Button>
      </div>
```

Change the outer `div`'s className and the heading's className:

```tsx
      <div className="mb-8 flex flex-col items-start gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-1.5 text-sm font-medium text-muted-foreground">Bonjour !</div>
          <h1 className="text-[22px] leading-tight font-black tracking-tight text-foreground sm:text-[30px]">{summarySentence(devices)}</h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-1 shrink-0"
          disabled={forceSyncMutation.isPending || devices.length === 0}
          onClick={() => forceSyncMutation.mutate()}
        >
          <RefreshCw size={14} className={forceSyncMutation.isPending ? 'animate-spin' : undefined} />
          Forcer la synchro
        </Button>
      </div>
```

- [ ] **Step 3: Device detail page padding on mobile**

Open `frontend/src/routes/_authenticated/devices.$deviceId.tsx`. Find (line 197):

```tsx
        <h1 className="max-w-lg text-[32px] leading-tight font-black tracking-tight text-foreground">{statusHeadline(device, health)}</h1>
```

Change to:

```tsx
        <h1 className="max-w-lg text-[24px] leading-tight font-black tracking-tight text-foreground sm:text-[32px]">
          {statusHeadline(device, health)}
        </h1>
```

The outer container (line 170) is `<div className="mx-auto max-w-3xl">` — add horizontal padding for narrow viewports since `AppShell`'s `<main>` already dropped to `p-4` on mobile (Task 6), which is enough here; no further change needed to this container itself.

- [ ] **Step 4: Add device page — stack the claim form on mobile**

Open `frontend/src/routes/_authenticated/devices.add.tsx`. Find `UnnamedDeviceRow`'s form (lines 40-56):

```tsx
    <form onSubmit={handleSubmit} className="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted">
        <DeviceKindIcon kind={device.kind} size={20} className="text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm font-medium text-foreground">{device.id}</div>
        <div className="text-xs text-muted-foreground">
          {formatDeviceKind(device.kind)} · vu {formatRelativeTime(device.lastSeenAt)}
        </div>
      </div>
      <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nom de la plante" className="w-48" />
      <Button type="submit" disabled={!name.trim() || renameMutation.isPending}>
        Ajouter
      </Button>
    </form>
```

Change to:

```tsx
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center">
      <div className="flex items-center gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted">
          <DeviceKindIcon kind={device.kind} size={20} className="text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-medium text-foreground">{device.id}</div>
          <div className="text-xs text-muted-foreground">
            {formatDeviceKind(device.kind)} · vu {formatRelativeTime(device.lastSeenAt)}
          </div>
        </div>
      </div>
      <div className="flex gap-3 sm:contents">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nom de la plante"
          className="min-w-0 flex-1 sm:w-48 sm:flex-none"
        />
        <Button type="submit" disabled={!name.trim() || renameMutation.isPending}>
          Ajouter
        </Button>
      </div>
    </form>
```

- [ ] **Step 5: Calibration page heading on mobile**

Open `frontend/src/routes/_authenticated/devices.$deviceId.calibration.tsx`. Find (line 51):

```tsx
      <h1 className="text-[30px] leading-tight font-black tracking-tight text-foreground">Calibration Plant Dr</h1>
```

Change to:

```tsx
      <h1 className="text-[22px] leading-tight font-black tracking-tight text-foreground md:text-[30px]">Calibration Plant Dr</h1>
```

- [ ] **Step 6: Typecheck**

```bash
cd frontend && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7: Manual verification at ~375px**

With both dev servers running, visit at a ~375px viewport width: `/settings` (new card present and links to `/devices/add`), `/` (header stacks vertically above the device grid, no horizontal overflow), a device detail page (heading fits without wrapping awkwardly), `/devices/add` (claim form's icon/name/input/button stack sensibly, don't overflow), and the calibration page (heading fits). Confirm no page produces horizontal scroll at this width.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/routes/_authenticated/settings.tsx frontend/src/routes/_authenticated/index.tsx \
  frontend/src/routes/_authenticated/devices.\$deviceId.tsx frontend/src/routes/_authenticated/devices.add.tsx \
  frontend/src/routes/_authenticated/devices.\$deviceId.calibration.tsx
git commit -m "Responsive tweaks: settings add-device entry, dashboard/detail/add/calibration mobile padding"
```

---

## Task 9: Final cross-page responsive pass + lint

**Files:** none new — verification-only task, touches whatever Task 1-8 missed.

- [ ] **Step 1: Full lint pass**

```bash
pnpm lint:fix
```

Expected: no errors; if Biome reformats anything, review the diff before committing (should be whitespace/import-order only).

- [ ] **Step 2: Full typecheck, both packages**

```bash
cd backend && pnpm build
cd frontend && pnpm typecheck
```

Expected: both succeed with no errors (backend `build` runs `tsc`, exercising the new `history.ts` router and `readings.ts` changes end-to-end through the compiler).

- [ ] **Step 3: Full manual pass at 375px and 768px+ across every authenticated page**

With both dev servers running (mock provider), walk through, at both a ~375px and a desktop-width viewport: `/`, `/history`, `/settings`, a device detail page, `/devices/add`, and the calibration page, plus `/login` logged out. Confirm for each:
- No horizontal scrollbar at 375px.
- Mobile bottom nav present and correctly highlighting the active tab at 375px; absent (sidebar shown instead) at desktop width.
- No content hidden behind the fixed bottom nav bar.
- Nothing regressed at desktop width compared to before this plan (sidebar, spacing, and existing functionality — watering, sync, species assignment — all still work).

- [ ] **Step 4: Commit (only if Step 1 produced formatting changes)**

```bash
git add -A
git commit -m "Lint fixes after responsive layout pass"
```

If `pnpm lint:fix` made no changes, skip this commit entirely.
