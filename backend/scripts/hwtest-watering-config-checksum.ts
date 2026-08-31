// One-off, disposable hardware verification script — NOT part of the app, not committed to run in
// CI. Confirms the CONFIG_ID (checksum) fix in ble/parrot/wateringConfig.ts actually makes a
// watering-config write persist on a real Parrot Pot across a disconnect/reconnect, then restores
// the device's original config exactly as found. Target: pot 8733 (A0:14:3D:CD:87:33), the
// dedicated no-species-assigned test pot (docs/superpowers/specs/2026-08-31-parrot-ble-full-
// capture-reanalysis.md). Run only with the production `stroyplant` container stopped (shared
// Bluetooth adapter) — see the accompanying shell commands, not this file.
import { buildWateringConfigWriteValues, computeWateringConfigId, mergeWateringConfigOverrides } from '../src/ble/parrot/wateringConfig.js';
import { createNodeBleProvider } from '../src/providers/node-ble/index.js';

const DEVICE_ID = 'A0:14:3D:CD:87:33';

function fmt(config: Record<string, unknown>): string {
  return JSON.stringify(config);
}

async function main() {
  const provider = createNodeBleProvider();

  console.log('--- Step 1: read current config ---');
  const original = await provider.readWateringConfig(DEVICE_ID);
  console.log('original:', fmt(original));
  const originalChecksumOk = original.configId === computeWateringConfigId(original);
  console.log(`original CONFIG_ID self-consistent: ${originalChecksumOk} (device=${original.configId}, computed=${computeWateringConfigId(original)})`);
  if (!originalChecksumOk) {
    console.warn('WARNING: device is currently in an inconsistent state — proceeding anyway, will restore to this exact read either way.');
  }

  console.log('\n--- Step 2: write a new, distinguishable config (full batch, correct CONFIG_ID) ---');
  const newVwcIrrRaw = original.vwcIrrRaw + 37; // arbitrary, distinguishable, unlikely to collide with anything real
  const newVwcCmdRaw = original.vwcCmdRaw + 41;
  const overrides = { vwcIrrRaw: newVwcIrrRaw, vwcCmdRaw: newVwcCmdRaw };
  const merged = mergeWateringConfigOverrides(original, overrides);
  const toWrite = buildWateringConfigWriteValues(merged);
  console.log('writing:', fmt(toWrite));
  await provider.writeWateringConfig(DEVICE_ID, toWrite);
  console.log('write done, connection closed by provider.');

  console.log('\n--- Step 3: wait 5s, then reconnect and read back ---');
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const afterWrite = await provider.readWateringConfig(DEVICE_ID);
  console.log('read back:', fmt(afterWrite));
  const persisted = afterWrite.vwcIrrRaw === newVwcIrrRaw && afterWrite.vwcCmdRaw === newVwcCmdRaw;
  console.log(`\n>>> PERSISTED ACROSS RECONNECT: ${persisted} <<<`);

  console.log('\n--- Step 4: restore the original config exactly as found ---');
  const restoreValues = buildWateringConfigWriteValues(original);
  await provider.writeWateringConfig(DEVICE_ID, restoreValues);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const afterRestore = await provider.readWateringConfig(DEVICE_ID);
  console.log('read back after restore:', fmt(afterRestore));
  const restored = afterRestore.vwcIrrRaw === original.vwcIrrRaw && afterRestore.vwcCmdRaw === original.vwcCmdRaw && afterRestore.mode === original.mode;
  console.log(`>>> RESTORED TO ORIGINAL: ${restored} <<<`);

  if (!persisted) process.exitCode = 1;
  if (!restored) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error('FATAL:', error);
    process.exit(1);
  });
