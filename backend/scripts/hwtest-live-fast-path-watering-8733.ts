// One-off, disposable hardware verification script — NOT part of the app, not committed to run in
// CI. Confirms the live-mode-default branch's fast-path watering (LiveConnectionHandle.triggerWatering,
// backend/src/providers/node-ble/index.ts's subscribeLive) actually works on real BlueZ hardware: a
// GATT write to the Watering service (39e1f900, trigger f906) while GATT notifications are actively
// running on a *different* service (Sensor, 39e1fa00, fa05/fa0a/fa0b) on the SAME connection — never
// tested before this script, per docs/superpowers/specs/2026-09-02-live-mode-default-design.md's
// explicitly flagged risk. Target: pot 8733 (A0:14:3D:CD:87:33), the dedicated no-species-assigned
// test pot already used for prior real watering-trigger confirmation tests (see CLAUDE.md). Run only
// with the production `stroyplant` container stopped (shared Bluetooth adapter) — see the
// accompanying shell commands, not this file.
import { createNodeBleProvider } from '../src/providers/node-ble/index.js';
import type { LiveConnectionHandle } from '../src/providers/types.js';

const DEVICE_ID = 'A0:14:3D:CD:87:33';
const PRE_TRIGGER_WINDOW_MS = 30_000;
const POST_TRIGGER_WINDOW_MS = 15_000;

function ts() {
  return new Date().toISOString();
}

async function main() {
  const provider = createNodeBleProvider();
  const controller = new AbortController();

  let sampleCount = 0;
  let samplesAfterTrigger = 0;
  let handle: LiveConnectionHandle | null = null;
  let handleReadyAt: number | null = null;
  let triggerStartedAt: number | null = null;
  let triggerCompletedAt: number | null = null;
  let triggerError: unknown = null;
  let sessionError: unknown = null;

  const sessionPromise = provider
    .subscribeLive(
      DEVICE_ID,
      'PARROT_POT',
      async (sample) => {
        sampleCount += 1;
        if (triggerCompletedAt !== null) samplesAfterTrigger += 1;
        console.log(`[${ts()}] sample #${sampleCount}${triggerCompletedAt !== null ? ' (post-trigger)' : ''}:`, sample.data);
      },
      controller.signal,
      (h) => {
        handle = h;
        handleReadyAt = Date.now();
        console.log(`[${ts()}] LiveConnectionHandle ready (GATT connected, before notifications started).`);
      },
    )
    .catch((error) => {
      sessionError = error;
      console.error(`[${ts()}] subscribeLive rejected:`, error);
    });

  console.log(`[${ts()}] --- Step 1: waiting up to ${PRE_TRIGGER_WINDOW_MS}ms for notifications + handle ---`);
  await new Promise((resolve) => setTimeout(resolve, PRE_TRIGGER_WINDOW_MS));

  if (!handle) {
    console.error(`[${ts()}] FATAL: no LiveConnectionHandle after ${PRE_TRIGGER_WINDOW_MS}ms — aborting session.`);
    controller.abort();
    await sessionPromise;
    process.exitCode = 1;
    return;
  }
  if (sampleCount === 0) {
    console.warn(`[${ts()}] WARNING: no live samples received yet before triggering watering — proceeding anyway, will keep watching after.`);
  }

  console.log(`[${ts()}] --- Step 2: calling triggerWatering() via the live connection (writes 39e1f906 on pot with no plant) ---`);
  triggerStartedAt = Date.now();
  try {
    await handle.triggerWatering();
    triggerCompletedAt = Date.now();
    console.log(`[${ts()}] triggerWatering() resolved OK in ${triggerCompletedAt - triggerStartedAt}ms.`);
  } catch (error) {
    triggerError = error;
    console.error(`[${ts()}] triggerWatering() THREW:`, error);
  }

  console.log(`[${ts()}] --- Step 3: waiting ${POST_TRIGGER_WINDOW_MS}ms to confirm notifications keep flowing after the write ---`);
  await new Promise((resolve) => setTimeout(resolve, POST_TRIGGER_WINDOW_MS));

  console.log(`[${ts()}] --- Step 4: aborting live session cleanly ---`);
  controller.abort();
  await sessionPromise;

  console.log('\n=== SUMMARY ===');
  console.log(`handle ready: ${handle !== null}${handleReadyAt ? ` (after ${handleReadyAt}ms wall-clock from start)` : ''}`);
  console.log(`total samples received: ${sampleCount}`);
  console.log(`samples received AFTER the trigger write: ${samplesAfterTrigger}`);
  console.log(`triggerWatering() succeeded: ${triggerError === null && triggerCompletedAt !== null}`);
  if (triggerError) console.log(`triggerWatering() error: ${String(triggerError)}`);
  console.log(`session ended with an error: ${sessionError !== null}`);
  if (sessionError) console.log(`session error: ${String(sessionError)}`);

  const ok = handle !== null && triggerError === null && triggerCompletedAt !== null && samplesAfterTrigger > 0 && sessionError === null;
  console.log(`\n>>> FAST-PATH WATERING DURING LIVE SESSION WORKS ON REAL HARDWARE: ${ok} <<<`);
  if (!ok) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error('FATAL:', error);
    process.exit(1);
  });
