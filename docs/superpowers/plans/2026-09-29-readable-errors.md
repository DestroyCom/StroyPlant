# Affichage d'erreurs lisible Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every raw technical error shown to the user (BLE `errorDetail`, English backend
messages) with a clear French cause + context-dependent advice, the raw text kept behind a
collapsible "Détails techniques".

**Architecture:** One pure frontend module (`describe-error.ts`) holds an ordered regex table
mapping known raw errors to a French message, plus a hint chosen by context
(`sync`/`watering`/`action`). A small `ErrorDetail` component renders it (message + hint +
collapsible raw) where `errorDetail` is shown today; `getErrorMessage()` (every toast) reuses the
same table. The database keeps raw text unchanged. The backend's own English `TRPCError` messages
are translated to French at the source.

**Tech Stack:** React 19, TanStack Query, Tailwind v4 (frontend); Fastify/tRPC (backend);
`node:test` via `tsx --test` (new in the frontend, same as the backend).

**Spec:** `docs/superpowers/specs/2026-09-29-readable-errors-design.md`

## Global Constraints

- `pnpm` exclusively, never `npm`/`yarn`. TypeScript only.
- Frontend typecheck is `cd frontend && pnpm typecheck` — **never** the bare `npx tsc --noEmit`
  in `frontend/`, which is a silent no-op (CLAUDE.md Gotchas).
- Backend: `cd backend && pnpm exec tsc --noEmit && pnpm test`.
- Biome: 2 spaces, single quotes (`npx biome check --write <files>`).
- No database, BLE provider, MQTT or MCP change. Raw `errorDetail` stays stored as-is.
- Unknown raw error in an `errorDetail` → "Erreur inattendue." + raw in details, never an invented
  message. Unknown message in a **toast** → shown unchanged (it's our own backend text).
- No infrastructure product names in committed files (public repo): say "proxy", never the
  provider's name.
- Commits: no `Co-Authored-By` line (DestCom's global rule).

## File Structure

- Create `frontend/src/lib/describe-error.ts` — the regex table + `describeError()`. Owns
  `PROXY_TIMEOUT_MESSAGE` (moved from `format-error.ts`).
- Create `frontend/src/lib/describe-error.test.ts` — `node:test` coverage of the table.
- Modify `frontend/src/lib/format-error.ts` — `getErrorMessage()` delegates to `describeError`.
- Create `frontend/src/lib/format-error.test.ts`.
- Create `frontend/src/components/error-detail.tsx` — `<ErrorDetail raw context />`.
- Modify `frontend/src/routes/_authenticated/history.tsx`, `devices.$deviceId.tsx`, `plants.tsx`.
- Modify `frontend/package.json` (`test` script, `tsx` devDependency), `frontend/tsconfig.app.json`
  (exclude tests), `frontend/tsconfig.node.json` (include tests, it already has Node types).
- Modify backend routers `devices.ts`, `health.ts`, `liveSession.ts`, `plantDr.ts`, `schedule.ts`,
  `wateringConfig.ts` and `backend/src/wateringConfigPush.ts` — French messages.
- Modify `CLAUDE.md`, `docs/superpowers/specs/2026-08-31-ui-overhaul-roadmap.md`.

---

### Task 1: `describeError` + frontend test runner

**Files:**
- Create: `frontend/src/lib/describe-error.ts`
- Create: `frontend/src/lib/describe-error.test.ts`
- Modify: `frontend/package.json`, `frontend/tsconfig.app.json`, `frontend/tsconfig.node.json`

**Interfaces:**
- Produces:
  - `export type ErrorContext = 'sync' | 'watering' | 'action'`
  - `export interface DescribedError { message: string; hint: string | null; raw: string; known: boolean }`
  - `export function describeError(raw: string, context: ErrorContext): DescribedError`
  - `export const PROXY_TIMEOUT_MESSAGE: string`

- [ ] **Step 1: Add the test runner**

```bash
cd frontend && pnpm add -D tsx@^4.19.2
```

In `frontend/package.json` `"scripts"`, add after `"typecheck"`:

```json
    "test": "tsx --test 'src/**/*.test.ts'",
```

In `frontend/tsconfig.app.json`, add after `"include": ["src"]` (so the DOM-typed app program never
sees `node:test`):

```json
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
```

In `frontend/tsconfig.node.json` (already `"types": ["node"]`), change the include so tests are
still typechecked by `pnpm typecheck`:

```json
  "include": ["vite.config.ts", "src/**/*.test.ts"]
```

- [ ] **Step 2: Write the failing test**

```ts
// frontend/src/lib/describe-error.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeError, PROXY_TIMEOUT_MESSAGE } from './describe-error.ts';

// Every raw shape actually stored in production on 2026-09-29 (see the spec's inventory table),
// with real-looking MACs/durations — the table must not depend on them.
const REAL_SHAPES: Array<[string, string]> = [
  ['le-connection-abort-by-local', 'coupée en cours de route'],
  ['TIMEOUT: connect (18000ms)', "n'a pas répondu à la demande de connexion"],
  ['TIMEOUT: gatt (18000ms)', "n'a pas transmis la liste de ses capteurs"],
  ['operation timed out', "n'a pas répondu à la demande de connexion"],
  ['Malformed soilMoisturePercent (fa07) buffer: 1 byte(s), expected 4 (hex=00)', 'réponse incomplète'],
  ['Attempt to access memory outside buffer bounds', 'réponse incomplète'],
  ['Operation already in progress', 'connexion précédente'],
  ['Operation failed with ATT error: 0x0e', 'refusé la lecture'],
  ['br-connection-canceled', "n'a pas répondu à la demande de connexion"],
  ['TIMEOUT: notification LYWSD03MMC (8000ms)', "n'a pas envoyé sa mesure"],
  ['Refusing activation, D-Bus is shutting down.', 'en train de redémarrer'],
];

describe('describeError', () => {
  for (const [raw, expected] of REAL_SHAPES) {
    it(`recognizes "${raw}"`, () => {
      const described = describeError(raw, 'sync');
      assert.equal(described.known, true);
      assert.ok(described.message.includes(expected), described.message);
      assert.equal(described.raw, raw);
    });
  }

  it('ignores a MAC address embedded in the raw text', () => {
    assert.equal(describeError('A0:14:3D:CD:A3:D3: le-connection-abort-by-local', 'sync').known, true);
  });

  it('falls back honestly on an unknown error, without a hint', () => {
    const described = describeError('something nobody has seen before', 'sync');
    assert.deepEqual(described, {
      message: 'Erreur inattendue.',
      hint: null,
      raw: 'something nobody has seen before',
      known: false,
    });
  });

  it('picks the hint from the context', () => {
    assert.equal(describeError('TIMEOUT: gatt (18000ms)', 'sync').hint, 'Nouvelle tentative automatique au prochain cycle.');
    assert.equal(describeError('TIMEOUT: gatt (18000ms)', 'watering').hint, "L'arrosage n'a pas eu lieu — tu peux réessayer.");
    assert.equal(describeError('TIMEOUT: gatt (18000ms)', 'action').hint, 'Réessaie dans un instant.');
  });

  it('adds the server-Bluetooth hint only for connection failures in a sync', () => {
    const serverHint = 'Si ça dure sur tous les appareils, le Bluetooth du serveur est probablement en cause.';
    assert.ok(describeError('le-connection-abort-by-local', 'sync').hint?.endsWith(serverHint));
    assert.ok(describeError('TIMEOUT: connect (18000ms)', 'sync').hint?.endsWith(serverHint));
    assert.ok(!describeError('le-connection-abort-by-local', 'watering').hint?.includes(serverHint));
    assert.ok(!describeError('TIMEOUT: gatt (18000ms)', 'sync').hint?.includes(serverHint));
  });

  it('maps the proxy HTML error page to the existing proxy message, without a separate hint', () => {
    const described = describeError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, 'action');
    assert.equal(described.message, PROXY_TIMEOUT_MESSAGE);
    assert.equal(described.hint, null);
    assert.equal(described.known, true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd frontend && pnpm test`
Expected: FAIL — `Cannot find module './describe-error.ts'`.

- [ ] **Step 4: Implement**

```ts
// frontend/src/lib/describe-error.ts
// Turns a raw technical error (BLE provider message stored in SyncEvent/WateringEvent.errorDetail,
// or a caught tRPC error) into a clear French cause + context-dependent advice — see
// docs/superpowers/specs/2026-09-29-readable-errors-design.md. The database keeps the raw text;
// translation only happens at display time, so existing history is covered with no migration.

export type ErrorContext = 'sync' | 'watering' | 'action';

export interface DescribedError {
  message: string;
  hint: string | null;
  raw: string;
  known: boolean;
}

// A slow BLE mutation can exceed an intermediate reverse-proxy's own timeout, which returns its
// own HTML error page instead of the real backend response — the tRPC client then fails to
// JSON.parse it, surfacing as a raw `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
// SyntaxError. Deliberately generic — no infrastructure detail here.
export const PROXY_TIMEOUT_MESSAGE =
  "Le serveur met trop de temps à répondre (délai dépassé au niveau du proxy). L'opération est peut-être quand même en cours ou déjà terminée côté appareil — vérifie avant de réessayer.";

// 'connection' rules get the extra server-Bluetooth hint in a sync context: when every device
// fails that way at once, the server's Bluetooth stack is the likely culprit (2026-09-28 BlueZ
// incident). 'proxy' carries its own advice inside its message.
type RuleKind = 'connection' | 'device' | 'proxy';

interface Rule {
  pattern: RegExp;
  message: string;
  kind: RuleKind;
}

// Ordered — the first match wins, so variable MACs/durations in the raw text never matter.
const RULES: Rule[] = [
  { pattern: /<!doctype/i, message: PROXY_TIMEOUT_MESSAGE, kind: 'proxy' },
  {
    pattern: /le-connection-abort-by-local/i,
    message: "La connexion Bluetooth avec l'appareil a été coupée en cours de route (souvent un signal faible ou des interférences).",
    kind: 'connection',
  },
  {
    pattern: /TIMEOUT: connect|operation timed out|br-connection-canceled/i,
    message: "L'appareil n'a pas répondu à la demande de connexion (trop loin, piles faibles ou en veille).",
    kind: 'connection',
  },
  {
    pattern: /TIMEOUT: gatt/i,
    message: "L'appareil s'est connecté mais n'a pas transmis la liste de ses capteurs à temps.",
    kind: 'device',
  },
  { pattern: /Operation already in progress/i, message: 'Une connexion précédente à cet appareil était encore en cours.', kind: 'device' },
  { pattern: /Malformed .* buffer|outside buffer bounds/i, message: 'Un capteur a renvoyé une réponse incomplète.', kind: 'device' },
  { pattern: /ATT error/i, message: "L'appareil a refusé la lecture d'un capteur.", kind: 'device' },
  { pattern: /TIMEOUT: notification/i, message: "Le capteur n'a pas envoyé sa mesure à temps.", kind: 'device' },
  { pattern: /D-Bus is shutting down/i, message: 'Le service Bluetooth du serveur était en train de redémarrer.', kind: 'device' },
];

const CONTEXT_HINT: Record<ErrorContext, string> = {
  sync: 'Nouvelle tentative automatique au prochain cycle.',
  watering: "L'arrosage n'a pas eu lieu — tu peux réessayer.",
  action: 'Réessaie dans un instant.',
};

const SERVER_BLUETOOTH_HINT = 'Si ça dure sur tous les appareils, le Bluetooth du serveur est probablement en cause.';

function hintFor(kind: RuleKind, context: ErrorContext): string | null {
  if (kind === 'proxy') return null;
  const base = CONTEXT_HINT[context];
  return kind === 'connection' && context === 'sync' ? `${base} ${SERVER_BLUETOOTH_HINT}` : base;
}

export function describeError(raw: string, context: ErrorContext): DescribedError {
  const rule = RULES.find((candidate) => candidate.pattern.test(raw));
  if (!rule) return { message: 'Erreur inattendue.', hint: null, raw, known: false };
  return { message: rule.message, hint: hintFor(rule.kind, context), raw, known: true };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && pnpm test`
Expected: PASS, 16 tests.

Run: `cd frontend && pnpm typecheck`
Expected: exit 0 (the test file is now typechecked by `tsconfig.node.json`).

- [ ] **Step 6: Commit**

```bash
npx biome check --write frontend/src/lib/describe-error.ts frontend/src/lib/describe-error.test.ts
git add frontend/package.json pnpm-lock.yaml frontend/tsconfig.app.json frontend/tsconfig.node.json frontend/src/lib/describe-error.ts frontend/src/lib/describe-error.test.ts
git commit -m "feat: add describeError, a raw-error to French cause + advice table"
```

---

### Task 2: toasts go through `describeError`

**Files:**
- Modify: `frontend/src/lib/format-error.ts` (whole file)
- Create: `frontend/src/lib/format-error.test.ts`

**Interfaces:**
- Consumes: `describeError`, from Task 1.
- Produces: `getErrorMessage(error: unknown): string`, same signature as today. All ~25 existing
  call sites stay untouched.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/format-error.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROXY_TIMEOUT_MESSAGE } from './describe-error.ts';
import { getErrorMessage } from './format-error.ts';

describe('getErrorMessage', () => {
  it('keeps our own backend messages unchanged (not a known technical pattern)', () => {
    assert.equal(getErrorMessage(new Error('Un appareil avec cette adresse existe déjà')), 'Un appareil avec cette adresse existe déjà');
  });

  it('translates a known technical error, with the generic action hint', () => {
    assert.equal(
      getErrorMessage(new Error('le-connection-abort-by-local')),
      "La connexion Bluetooth avec l'appareil a été coupée en cours de route (souvent un signal faible ou des interférences). Réessaie dans un instant.",
    );
  });

  it('keeps the proxy HTML error page case working', () => {
    assert.equal(getErrorMessage(new Error(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`)), PROXY_TIMEOUT_MESSAGE);
  });

  it('accepts a non-Error value', () => {
    assert.equal(getErrorMessage('plain string'), 'plain string');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm test`
Expected: FAIL on "translates a known technical error" (today's `getErrorMessage` returns the raw
text for anything but `<!DOCTYPE`).

- [ ] **Step 3: Implement — replace the whole file**

```ts
// frontend/src/lib/format-error.ts
import { describeError } from './describe-error';

// Every mutation/query error display in this app funnels through this instead of a bare
// `error.message`. A known technical error (BLE failure, proxy HTML page) becomes the same clear
// French text the history uses; anything else is shown unchanged, because in a toast an
// unrecognized message is almost always one of our own backend messages, already readable (e.g.
// "Un appareil avec cette adresse existe déjà") — replacing it with "Erreur inattendue" would be a
// regression. A toast can't hold a collapsible, so the raw text of a translated error goes to the
// console instead.
export function getErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const described = describeError(raw, 'action');
  if (!described.known) return raw;
  console.error('[error]', raw);
  return described.hint ? `${described.message} ${described.hint}` : described.message;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && pnpm test && pnpm typecheck`
Expected: PASS (20 tests), typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
npx biome check --write frontend/src/lib/format-error.ts frontend/src/lib/format-error.test.ts
git add frontend/src/lib/format-error.ts frontend/src/lib/format-error.test.ts
git commit -m "feat: route toast errors through describeError"
```

---

### Task 3: `ErrorDetail` component, wired where `errorDetail` is shown

**Files:**
- Create: `frontend/src/components/error-detail.tsx`
- Modify: `frontend/src/routes/_authenticated/history.tsx` (`HistoryRow`, the `entry.errorDetail`
  line, ~line 62)
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.tsx` ("Derniers arrosages", the
  `event.errorDetail` block, ~lines 377-379)
- Modify: `frontend/src/routes/_authenticated/plants.tsx:156`

**Interfaces:**
- Consumes: `describeError`, `ErrorContext` (Task 1), `getErrorMessage` (Task 2).
- Produces: `ErrorDetail({ raw, context }: { raw: string; context: ErrorContext })`.

- [ ] **Step 1: Create the component**

```tsx
// frontend/src/components/error-detail.tsx
import { useState } from 'react';
import { describeError, type ErrorContext } from '@/lib/describe-error';

// Clear French cause + advice for a stored raw error, the raw text itself kept one click away for
// debugging (spec: "repliable" — never the main line, never hidden entirely).
export function ErrorDetail({ raw, context }: { raw: string; context: ErrorContext }) {
  const [open, setOpen] = useState(false);
  const { message, hint } = describeError(raw, context);
  return (
    <div className="mt-0.5 text-xs text-muted-foreground">
      <p>
        {message}
        {hint && ` ${hint}`}
      </p>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mt-0.5 underline underline-offset-2 hover:text-foreground"
      >
        {open ? 'Masquer les détails techniques' : 'Détails techniques'}
      </button>
      {open && <pre className="mt-1 rounded bg-muted px-2 py-1 font-mono text-[11px] whitespace-pre-wrap break-all">{raw}</pre>}
    </div>
  );
}
```

- [ ] **Step 2: Wire the history page**

In `history.tsx`, add the import next to the other `@/components` imports:

```tsx
import { ErrorDetail } from '@/components/error-detail';
```

Replace:

```tsx
        {failed && entry.errorDetail && <div className="mt-0.5 text-xs wrap-break-word text-muted-foreground">{entry.errorDetail}</div>}
```

with:

```tsx
        {failed && entry.errorDetail && (
          // A config push (CONFIG_PUSH) is neither auto-retried like a poll nor a watering —
          // generic "réessaie" advice fits it best.
          <ErrorDetail
            raw={entry.errorDetail}
            context={entry.type === 'WATERING' ? 'watering' : entry.triggerLabel === 'CONFIG_PUSH' ? 'action' : 'sync'}
          />
        )}
```

- [ ] **Step 3: Wire "Derniers arrosages" on the device detail page**

In `devices.$deviceId.tsx`, add `import { ErrorDetail } from '@/components/error-detail';` with the
other `@/components` imports (alphabetical: after `EditDeviceDialog`). Replace:

```tsx
                        {!event.success && event.errorDetail && (
                          <div className="mt-0.5 text-xs text-muted-foreground">{event.errorDetail}</div>
                        )}
```

with:

```tsx
                        {!event.success && event.errorDetail && <ErrorDetail raw={event.errorDetail} context="watering" />}
```

- [ ] **Step 4: Last raw display — `plants.tsx:156`**

Replace `{filterGroupsError.message}` with `{getErrorMessage(filterGroupsError)}`
(`getErrorMessage` is already imported in that file).

- [ ] **Step 5: Verify**

Run: `cd frontend && pnpm typecheck && pnpm test`
Expected: exit 0, 20 tests pass.

Run: `git grep -n "errorDetail}" -- frontend/src`
Expected: no match (no raw `errorDetail` rendered anywhere anymore).

- [ ] **Step 6: Commit**

```bash
npx biome check --write frontend/src/components/error-detail.tsx frontend/src/routes/_authenticated/history.tsx 'frontend/src/routes/_authenticated/devices.$deviceId.tsx' frontend/src/routes/_authenticated/plants.tsx
git add frontend/src/components/error-detail.tsx frontend/src/routes/_authenticated/history.tsx 'frontend/src/routes/_authenticated/devices.$deviceId.tsx' frontend/src/routes/_authenticated/plants.tsx
git commit -m "feat: show readable errors with collapsible technical details in history and waterings"
```

---

### Task 4: backend's own error messages in French

**Files:**
- Modify: `backend/src/api/trpc/routers/devices.ts` (lines 55, 118, 139, 157, 169, 236),
  `health.ts` (42, 47, 106, 132), `liveSession.ts` (21), `plantDr.ts` (22, 23, 59, 60, 66, 71),
  `schedule.ts` (15, 44), `wateringConfig.ts` (13, 14, 34, 35, 37),
  `backend/src/wateringConfigPush.ts` (60)

**Interfaces:** none — message text only, no code-path change. Verified beforehand: no test and no
frontend/MCP code matches on these strings.

- [ ] **Step 1: Replace the strings (exact, whole-string replacements)**

Run from the repo root:

```bash
node -e '
const fs = require("fs");
const files = ["devices","health","liveSession","plantDr","schedule","wateringConfig"].map((f) => `backend/src/api/trpc/routers/${f}.ts`).concat("backend/src/wateringConfigPush.ts");
const map = [
  ["\x27Device not found\x27", "\x27Appareil introuvable\x27"],
  ["\x27Plant Dr is Parrot Pot only\x27", "\x27Fonction réservée au Parrot Pot\x27"],
  ["\x27Watering config is Parrot Pot only\x27", "\x27Fonction réservée au Parrot Pot\x27"],
  ["\x27A calibration is already running for this device\x27", "\x27Une calibration est déjà en cours pour cet appareil\x27"],
  ["\x27A config push is already running for this device\x27", "\x27Un envoi de configuration est déjà en cours pour cet appareil\x27"],
  ["\x27Assign a species with a known soil moisture minimum before calibrating\x27", "\"Assigne d\x27abord une espèce dont l\x27humidité minimale est connue\""],
  ["\x27Plant profile not found\x27", "\x27Espèce introuvable\x27"],
];
for (const f of files) {
  let s = fs.readFileSync(f, "utf8");
  for (const [a, b] of map) s = s.split(a).join(b);
  fs.writeFileSync(f, s);
}'
```

- [ ] **Step 2: Verify nothing English is left**

Run: `git grep -n -E "Device not found|Parrot Pot only'|already running for this device|soil moisture minimum before|Plant profile not found" -- backend/src`
Expected: no match (`'Device-side autonomous watering is Parrot Pot only'` in
`wateringConfigPush.ts` is an internal `Error`, out of scope, and does not match `Parrot Pot only'`
followed by nothing else — if it does show up, leave it).

Run: `cd backend && pnpm exec tsc --noEmit && pnpm test`
Expected: exit 0, all tests pass (219 at the time of writing).

- [ ] **Step 3: Commit**

```bash
npx biome check --write backend/src/api/trpc/routers backend/src/wateringConfigPush.ts
git add backend/src/api/trpc/routers backend/src/wateringConfigPush.ts
git commit -m "fix: translate the backend's own user-facing error messages to French"
```

---

### Task 5: visual verification + docs

**Files:**
- Modify: `CLAUDE.md` (new "Project status" entry before `## Repo structure`)
- Modify: `docs/superpowers/specs/2026-08-31-ui-overhaul-roadmap.md` (tick sous-projet 5, remove the
  proxy provider's name)

- [ ] **Step 1: Inject one failure per shape into the dev database (backup first)**

```bash
cd backend && cp prisma/dev.db /tmp/dev.db.before-readable-errors
sqlite3 prisma/dev.db "
INSERT INTO SyncEvent (deviceId, source, errorDetail, timestamp) VALUES
 ('MOCK-POT-NORMAL','POLL','le-connection-abort-by-local', CAST(strftime('%s','now') AS INTEGER) * 1000),
 ('MOCK-POT-NORMAL','POLL','TIMEOUT: connect (18000ms)', CAST(strftime('%s','now') AS INTEGER) * 1000 - 60000),
 ('MOCK-POT-NORMAL','POLL','TIMEOUT: gatt (18000ms)', CAST(strftime('%s','now') AS INTEGER) * 1000 - 120000),
 ('MOCK-POT-NORMAL','MANUAL','Operation failed with ATT error: 0x0e', CAST(strftime('%s','now') AS INTEGER) * 1000 - 180000),
 ('MOCK-POT-NORMAL','POLL','something nobody has seen before', CAST(strftime('%s','now') AS INTEGER) * 1000 - 240000);
INSERT INTO WateringEvent (deviceId, triggerSource, success, errorDetail, timestamp) VALUES
 ('MOCK-POT-NORMAL','MANUAL',0,'le-connection-abort-by-local', CAST(strftime('%s','now') AS INTEGER) * 1000 - 300000);"
```

Prisma stores `DateTime` in SQLite as epoch-milliseconds integers (checked on `dev.db`), hence
the `* 1000` arithmetic above rather than an ISO string. If the insert fails on a column name, read the real columns with
`sqlite3 prisma/dev.db ".schema SyncEvent"` / `".schema WateringEvent"` and adapt — do not guess.

- [ ] **Step 2: Check it in a real browser (mock provider)**

Start `cd backend && pnpm dev` and `cd frontend && pnpm dev`, log in with `admin@admin.com` /
`admin`, then:
1. `/history`: each injected row shows its French message + hint; the `sync` rows with a
   connection failure also show the server-Bluetooth hint; the unknown one shows "Erreur
   inattendue."; clicking "Détails techniques" reveals the exact raw text, clicking again hides it.
2. `/devices/MOCK-POT-NORMAL` → "Derniers arrosages": the failed watering shows the `watering`
   hint ("L'arrosage n'a pas eu lieu — tu peux réessayer.").
3. Trigger "Arroser maintenant" on `MOCK-POT-DECLINE` (empty reservoir → real failure): the toast
   shows a readable message.

- [ ] **Step 3: Restore the dev database and stop the servers**

```bash
cp /tmp/dev.db.before-readable-errors backend/prisma/dev.db && rm /tmp/dev.db.before-readable-errors
```

- [ ] **Step 4: Docs**

In `CLAUDE.md`, insert before `## Repo structure` a dated entry "**Affichage d'erreurs lisible**
✅ (2026-09-29)" summarizing: the 3 validated decisions (collapsible raw, cause + action, frontend
display-time translation with the DB left raw), the 11 real production shapes the table covers,
the context-dependent hint (incl. `CONFIG_PUSH` → `action`), the toast "unknown stays unchanged"
rule, the backend messages translated at source, the new frontend test runner
(`cd frontend && pnpm test`, tests excluded from `tsconfig.app.json` and typechecked via
`tsconfig.node.json`), and what was verified (tests, typecheck, browser pass above). Also add
`cd frontend && pnpm test` to the "Tooling" section.

In the roadmap, replace
`- [ ] Sous-projet 5 — Affichage d'erreurs lisible : brainstorming → spec → plan → implémentation (indépendant, peut être avancé n'importe quand)`
with a ticked line pointing to the spec, this plan and the CLAUDE.md entry, and replace every
mention of the proxy provider's name in that file by "le proxy" (e.g. "l'erreur Cloudflare 502" →
"l'erreur 502 du proxy", and the quoted gotcha title → "le gotcha sur le délai du proxy").

Run: `git grep -n -i cloudflare -- docs/superpowers/specs/2026-08-31-ui-overhaul-roadmap.md`
Expected: no match.

- [ ] **Step 5: Final verification and commit**

Run: `cd backend && pnpm exec tsc --noEmit && pnpm test` and `cd frontend && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-31-ui-overhaul-roadmap.md
git commit -m "docs: log sous-projet 5 (affichage d'erreurs lisible) in CLAUDE.md and the roadmap"
```
