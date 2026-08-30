// One-off data fix, run manually against the real production database — deliberately NOT wired
// into docker-entrypoint.sh (that runs on every boot). Naturally idempotent: both update queries
// are scoped to rows where the source column is still non-null, so a second accidental run finds
// 0 matching rows and does nothing — safe to re-run, though there is no reason to.
//
// Confirmed via real BLE sniffing of the official Flower Power app on real hardware (2026-08-29,
// docs/superpowers/specs/2026-08-29-parrot-official-app-ble-sniffing-findings.md): the Parrot Pot
// Live-service characteristics were mismapped in this project's own code. The OLD code read
// `fa09` into `soilMoisturePercent` and `fa0a` into `temperatureC`. In reality `fa09` IS real
// temperature — so the OLD `soilMoisturePercent` column actually holds real, recoverable
// temperature data. But `fa0a` (the OLD `temperatureC` source) is NOT real soil moisture — it's a
// light-reactive characteristic of unconfirmed exact role. Real soil moisture lives at `fa07`,
// which the OLD code never read at all. This is NOT a simple swap: historical soil moisture was
// never recorded and cannot be recovered.
//
// So this script:
//   - moves the OLD soilMoisturePercent (real temperature data) into temperatureC
//   - sets soilMoisturePercent to NULL (DestCom's explicit choice — an honestly-missing value,
//     not a fabricated one; the old value there was light data mislabeled as moisture)
// Same treatment for RawSensorLog.soilMoistureCalibrated/airTempCalibrated (schema.prisma
// documents these as "duplicated from Reading.soilMoisturePercent"/"...temperatureC").
//
// Scoped to Device.kind === 'PARROT_POT' only — Xiaomi devices also populate `temperatureC` (their
// own legitimate air-temperature sensor, an entirely different device/protocol) and must not be
// touched.
//
// Run with: pnpm exec tsx scripts/fixSoilMoistureTemperatureSwap.ts
import { prisma } from '../src/db/client.js';

const CHUNK_SIZE = 500;

async function main(): Promise<void> {
  const parrotPotDeviceIds = (
    await prisma.device.findMany({
      where: { kind: 'PARROT_POT' },
      select: { id: true },
    })
  ).map((d) => d.id);

  if (parrotPotDeviceIds.length === 0) {
    console.log('No PARROT_POT devices found — nothing to do.');
    return;
  }
  console.log(`Found ${parrotPotDeviceIds.length} Parrot Pot device(s): ${parrotPotDeviceIds.join(', ')}`);

  const readings = await prisma.reading.findMany({
    where: {
      deviceId: { in: parrotPotDeviceIds },
      soilMoisturePercent: { not: null },
    },
    select: { id: true, soilMoisturePercent: true },
  });
  console.log(
    `Moving soilMoisturePercent -> temperatureC (real recovered temperature data) and nulling ` +
      `soilMoisturePercent (unrecoverable) on ${readings.length} Reading rows...`,
  );

  let updated = 0;
  for (let i = 0; i < readings.length; i += CHUNK_SIZE) {
    const chunk = readings.slice(i, i + CHUNK_SIZE);
    await prisma.$transaction(
      chunk.map((r) =>
        prisma.reading.update({
          where: { id: r.id },
          data: { temperatureC: r.soilMoisturePercent, soilMoisturePercent: null },
        }),
      ),
    );
    updated += chunk.length;
  }
  console.log(`Reading rows fixed: ${updated}`);

  const rawLogs = await prisma.rawSensorLog.findMany({
    where: {
      reading: { deviceId: { in: parrotPotDeviceIds } },
      soilMoistureCalibrated: { not: null },
    },
    select: { id: true, soilMoistureCalibrated: true },
  });
  console.log(
    `Moving soilMoistureCalibrated -> airTempCalibrated and nulling soilMoistureCalibrated on ` +
      `${rawLogs.length} RawSensorLog rows...`,
  );

  let rawUpdated = 0;
  for (let i = 0; i < rawLogs.length; i += CHUNK_SIZE) {
    const chunk = rawLogs.slice(i, i + CHUNK_SIZE);
    await prisma.$transaction(
      chunk.map((r) =>
        prisma.rawSensorLog.update({
          where: { id: r.id },
          data: { airTempCalibrated: r.soilMoistureCalibrated, soilMoistureCalibrated: null },
        }),
      ),
    );
    rawUpdated += chunk.length;
  }
  console.log(`RawSensorLog rows fixed: ${rawUpdated}`);

  console.log('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
