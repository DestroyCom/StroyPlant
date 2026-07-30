# Responsive layout + global history page — design spec

Date: 2026-07-30
Status: approved by DestCom, ready for implementation planning

## Purpose

The frontend (Batch 3) was built desktop-first and is unusable on a phone today: `AppShell`'s
sidebar (`frontend/src/components/app-shell.tsx`) is a fixed `w-54` element with no responsive
behavior, so on a narrow viewport it eats most of the screen width and there's no mobile
navigation pattern at all. DestCom provided 4 wireframe screens (dashboard, journal d'arrosage,
réglages, login) showing the intended mobile layout: a compact top header (logo + name), full-width
stacked cards, and a 3-tab bottom navigation bar (Plantes / Historique / Réglages).

Two things fall out of matching that wireframe:
1. Every existing page needs responsive adjustments (this is the actual ask: "faire le responsive
   du site").
2. The wireframe's "Historique" tab points at a **global watering journal across all devices**,
   which doesn't exist yet — `docs/STROYPLANT_SPEC.md`'s Batch 3 scope explicitly lists "global
   History" as not done. Building it is now part of this task, and DestCom asked for it to include
   not just successful waterings but **sync/BLE read failures too**, which aren't persisted
   anywhere today (only logged to console) — so this also adds a new persisted event log for those.

## Scope

In scope:
- Responsive breakpoint strategy for `AppShell` (sidebar/mobile header/bottom tab bar).
- Responsive adjustments to every existing authenticated page (dashboard, device detail, add
  device, calibration, settings) and to the login page.
- A new global history page (`/history`) covering **all** devices.
- A new `SyncEvent` Prisma model + migration, persisting sync/read failures that today are only
  logged to console, so the history page can surface them.
- A "Ajouter un appareil" entry in Settings (mobile has no room for it in the 3-tab bottom nav).

Out of scope (explicitly not part of this task):
- Any change to BLE protocol logic, retry/backoff policy, or the scanner's actual scan/read
  behavior — only *persisting* failures that are already caught and logged is in scope, not
  changing when/how they're caught.
- A JS-based viewport-detection hook (`useMediaQuery` or similar) — the whole responsive layout is
  done with Tailwind breakpoint classes only, consistent with how `login.tsx` already hides/shows
  its hero panel via `hidden md:flex`.
- Persisting successful sync reads as events (see Data model below for why).
- Any notification/alert system (Settings already shows "Notifications" as a disabled
  "coming soon" card, unrelated to this task).

## Part 1 — Responsive layout

### Breakpoint

`md` (768px), matching the existing split already used in `login.tsx`. Below `md` = mobile layout;
`md` and up = today's desktop layout, unchanged.

### `AppShell` (`frontend/src/components/app-shell.tsx`)

- The existing `<aside>` sidebar becomes `hidden md:flex` — desktop behavior is otherwise untouched.
- New mobile-only top header (`flex md:hidden`): logo + "StroyPlant" wordmark, same asset
  (`@/assets/logo.svg`) and styling as the sidebar's own header row.
- New mobile-only bottom tab bar (`flex md:hidden`, `fixed bottom-0` + `inset-x-0`), 3 tabs:
  - Plantes → `/` (Home icon)
  - Historique → `/history` (Clock icon, new page — see Part 2)
  - Réglages → `/settings` (Settings icon)
  Active tab styling reuses the same `data-[status=active]` pattern already used by the sidebar's
  `<Link>`s.
- `<main>` gains `pb-20 md:pb-0` on mobile so content doesn't scroll under the fixed bottom bar.
- No "+"/add-device icon anywhere in the mobile chrome — confirmed with DestCom that on mobile,
  "Ajouter un appareil" only needs to be reachable from Settings (see Part 3).

### Per-page adjustments

No structural changes, only responsive utility classes:
- **Dashboard** (`routes/_authenticated/index.tsx`): header row (`greeting` + "Forcer la synchro"
  button) stacks vertically below `md`; the device grid
  (`grid-cols-[repeat(auto-fill,minmax(260px,1fr))]`) already collapses to one column naturally
  under 768px given the `260px` minmax floor, so no class change needed there — verify visually
  during implementation rather than assuming.
- **Device detail, add device, calibration, settings**: outer page padding `p-10` → `p-4 md:p-10`;
  heading sizes that use fixed `text-[30px]`/`text-[26px]` get a smaller mobile value (e.g.
  `text-[22px] md:text-[30px]`); any `max-w-xl`/fixed-width forms stay as-is (already narrow enough
  to fit mobile widths, just re-verify padding at 375px during implementation).
- **Login page** (`routes/login.tsx`): see Part 3.

## Part 2 — Global history page

### Data model: `SyncEvent` (new)

`WateringEvent` (existing) already captures every watering attempt, success or failure
(`triggerSource: MANUAL | CRON`, `success: boolean`, `errorDetail: String?`) — reused as-is, no
changes needed to it or to `triggerWatering()`.

Sync/read failures have no equivalent today: `scanner.ts`'s `pollDeviceNow`, and
`devices.ts`'s `sync`/`forceSyncAll` mutations, all catch a failed `provider.readSensors()` call and
only `log(...)` it to the console — never persisted, so DestCom has no way to see "this device
failed to sync 3 times last night" other than grepping server logs. New model:

```prisma
enum SyncSource {
  POLL   // scanner's own throttled polling loop
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

**Only failures are ever inserted** — a successful sync already has a `Reading` row proving it
happened; duplicating every successful poll (5 devices × ~1/5min) into a second table would add
volume with zero new information. `errorDetail` is required (non-null) since every row in this
table is, by construction, a failure.

Wired into the 3 existing catch sites, via a new shared helper `persistSyncFailure(deviceId,
source, errorDetail)` in `backend/src/readings.ts` (next to the existing `persistReading`), so the
insert logic lives once rather than being copy-pasted 3 times:

- `backend/src/ble/scanner.ts:43-51` (`pollDeviceNow`'s catch) → `source: 'POLL'`, called after the
  existing `log(...)` call, not instead of it (console logging stays, this is additive).
- `backend/src/api/trpc/routers/devices.ts`, `sync` mutation's catch block → `source: 'MANUAL'`,
  persisted before the existing `TRPCError({code:'BAD_GATEWAY'})` is thrown (never instead of
  throwing — the caller still needs to know their manual sync failed synchronously).
- `backend/src/api/trpc/routers/devices.ts`, `forceSyncAll`'s catch block → `source: 'MANUAL'`,
  alongside the existing `log(...)` call.

### Backend: `history` tRPC router (new)

New file `backend/src/api/trpc/routers/history.ts`, one procedure:

```ts
list: protectedProcedure
  .input(z.object({ deviceId: z.string().optional(), days: z.number().optional() }))
  .query(...)
```

- `days` undefined = all-time (no lower bound on `timestamp`); when provided, filters both queries
  to `timestamp: { gte: since }` — matches the wireframe's "Tout / 7 jours / 30 jours" pills.
- `deviceId` undefined = every named device; when provided, filters both queries to that device —
  matches the wireframe's "Toutes les plantes" dropdown.
- Queries `WateringEvent` and `SyncEvent` in parallel (each already indexed on
  `[deviceId, timestamp]`), each including `device: { select: { name: true } }`, maps both into one
  common shape, concatenates, sorts by `timestamp` desc in application code, and caps the result
  (e.g. `slice(0, 200)`) — a single global feed across an unbounded number of devices/days has no
  natural SQL-level combined sort/limit without a raw union query, and 200 rows is already far more
  than a personal-use, ~5-device installation will produce in any reasonable window.

Common shape returned to the frontend:
```ts
{
  id: string;          // `watering-${id}` / `sync-${id}`, so a WateringEvent and a SyncEvent can
                        // never collide as React keys
  type: 'WATERING' | 'SYNC';
  deviceId: string;
  deviceName: string;
  timestamp: string;    // ISO, via the existing serializeDate
  success: boolean;     // SyncEvent rows are always false (see Data model)
  triggerLabel: 'MANUAL' | 'CRON' | 'POLL'; // WateringEvent's MANUAL/CRON, or SyncEvent's POLL/MANUAL
  errorDetail: string | null;
}
```

Mounted in `router.ts` as `history` alongside the existing `devices`/`health`/`mqtt`/`schedule`/
`plantDr`/`liveSession`/`readings` routers.

### Frontend: `/history` page

New file `frontend/src/routes/_authenticated/history.tsx`, matching the wireframe:
- A device filter dropdown ("Toutes les plantes" + one entry per named device, from the already
  fetched `devices.list`).
- 4 filter pills: Tout / 7 jours / 30 jours (client-side state, re-queries `history.list` with the
  corresponding `days` value — `undefined`/`7`/`30`).
- Events grouped by calendar day under a French relative-date heading — "Aujourd'hui" / "Hier" /
  "Il y a N jours" — reusing/extending the relative-time helpers already in
  `frontend/src/lib/format.ts` rather than duplicating date math.
- Each row: a droplet icon (watering, matching the wireframe's blue droplet) for `type: 'WATERING'`
  rows, styled distinctly (e.g. destructive-toned icon/text) for any row with `success: false`
  regardless of type; label text:
  - Watering success: "`<deviceName>` a été arrosé{e} automatiquement" (CRON) / "à la main" (MANUAL)
    — reuses the wireframe's exact wording.
  - Watering failure: "Échec de l'arrosage de `<deviceName>` : `<errorDetail>`".
  - Sync failure: "Échec de synchro (`<automatique|manuelle>`) sur `<deviceName>` : `<errorDetail>`"
    — DestCom asked for as much detail as possible in the log, so POLL/MANUAL is spelled out
    ("automatique"/"manuelle") rather than collapsed, and the full `errorDetail` string is always
    shown in full (no truncation), matching the raw message `logger.ts` already writes to the
    console today.
- Linked from `AppShell`'s new mobile bottom tab bar (Part 1) and from the desktop sidebar, which
  gains a new "Historique" link (it has none today — the page didn't exist).

## Part 3 — Login mobile header + Settings entry

### Login (`frontend/src/routes/login.tsx`)

- The existing desktop hero panel (`hidden ... md:flex`) gets the logo + "StroyPlant" wordmark
  added above its `Leaf` icon circle, per DestCom's original ask — plain text/image row, same
  logo asset `AppShell` uses.
- A **new** compact mobile-only header (`flex md:hidden`, logo + "StroyPlant"), placed above the
  login form itself — today, hiding the hero panel below `md` leaves mobile with zero branding on
  the login screen; DestCom confirmed this should be fixed rather than left as-is.

### Settings (`frontend/src/routes/_authenticated/settings.tsx`)

New `Card` (same visual pattern as the existing "Arrosage automatique" card, which already just
links elsewhere) with a link to `/devices/add`, labeled "Ajouter un appareil" — visible at every
breakpoint (no conditional show/hide), since it's a reasonable shortcut on desktop too and adding
breakpoint-conditional logic here would be complexity with no real benefit.

## Testing plan

No real BLE hardware needed for any of this (pure frontend responsive work + a new read-heavy
backend feature) — verified against the mock provider and the dev DB:
- `SyncEvent` rows actually get created: force a failure path (e.g. temporarily point at a device
  id the mock provider doesn't know, or exercise `forceSyncAll`/`sync` against a device kind the
  mock provider errors on) and confirm a row lands with the right `source`.
- `history.list` round-trip: with/without `deviceId`, with each `days` value, confirms correct
  filtering, correct merge/sort ordering, and correct day-grouping labels on the frontend.
- Responsive layout manually verified in a Chromium viewport resized to a phone width (~375px) and
  back to desktop width, for every authenticated page plus login — sidebar/bottom-bar swap, no
  horizontal scroll, no content hidden under the fixed bottom bar.
