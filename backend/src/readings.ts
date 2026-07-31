import type { ReadingSource, SyncSource } from '@prisma/client';
import { emitReading } from './api/trpc/readingsEmitter.js';
import { serializeReading } from './api/trpc/serialize.js';
import { DEFAULT_POLL_INTERVAL_MS } from './ble/namedDevicePoller.js';
import { prisma } from './db/client.js';
import { getMqttState } from './mqtt/manager.js';
import { publishHealthState, publishReadingState } from './mqtt/publisher.js';
import type { DeviceKind, SensorReading } from './providers/types.js';

// Shared by the named-device poller's automatic poll cycle (ble/namedDevicePoller.ts), the manual
// "sync now"/"forcer la synchro" tRPC mutations (devices.sync/forceSyncAll),
// and the live-mode session manager (liveSession/manager.ts) — every producer of a Reading row
// goes through this one function so persistence/broadcast never diverges between them. `source` is
// required (no default) so every call site is explicit about which one it is — POLL rows feed the
// Health Engine's rolling baseline and history charts, LIVE rows never do (see
// docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md).
export async function persistReading(deviceId: string, kind: DeviceKind, reading: SensorReading, source: ReadingSource) {
  const data =
    reading.kind === 'PARROT_POT'
      ? {
          soilMoisturePercent: reading.data.soilMoisturePercent,
          temperatureC: reading.data.temperatureC,
          luminosity: reading.data.luminosity,
          waterTankLevelPercent: reading.data.waterTankLevelPercent,
          isDrySoil: reading.data.isDrySoil,
          isWetSoil: reading.data.isWetSoil,
          isEmptyTank: reading.data.isEmptyTank,
          isInAir: reading.data.isInAir,
        }
      : {
          temperatureC: reading.data.temperatureC,
          humidityPercent: reading.data.humidityPercent,
          batteryPercent: reading.data.batteryPercent,
        };

  // Raw sensor debug log (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-
  // and-raw-sensor-log-design.md) — created in the same transaction as the Reading it's 1:1 linked
  // to, so the two can never diverge (e.g. a Reading with no matching RawSensorLog row, which would
  // break the "post-migration reading" detection the history/health call sites rely on).
  const rawData =
    reading.kind === 'PARROT_POT'
      ? {
          lightRaw: reading.data.lightRaw,
          soilConductivityRaw: reading.data.soilConductivityRaw,
          soilTempRaw: reading.data.soilTempRaw,
          airTempRaw: reading.data.airTempRaw,
          soilMoistureRaw: reading.data.soilMoistureRaw,
          soilMoistureCalibrated: reading.data.soilMoisturePercent,
          airTempCalibrated: reading.data.temperatureC,
          luminosityCalibrated: reading.data.luminosity,
          eaRaw: reading.data.eaRaw,
          ecbRaw: reading.data.ecbRaw,
          ecPorousRaw: reading.data.ecPorousRaw,
          waterTankLevelPercent: reading.data.waterTankLevelPercent,
          watVwcIrr: reading.data.watVwcIrr,
          watVwcCmd: reading.data.watVwcCmd,
          watNIrr: reading.data.watNIrr,
          watPumpDutyCycle: reading.data.watPumpDutyCycle,
          watVwcIrrEco: reading.data.watVwcIrrEco,
          watVwcCmdEco: reading.data.watVwcCmdEco,
          watNIrrEco: reading.data.watNIrrEco,
          watMode: reading.data.watMode,
          watTimeSlotStart: reading.data.watTimeSlotStart,
          watTimeSlotDurr: reading.data.watTimeSlotDurr,
          watVacationStart: reading.data.watVacationStart,
          watVacationEnd: reading.data.watVacationEnd,
          algorithmStatus: reading.data.algorithmStatus,
          plantDrStatusFlagsRaw: reading.data.plantDrStatusFlagsRaw,
          plantDrDryN: reading.data.plantDrDryN,
          plantDrDryVwcRaw: reading.data.plantDrDryVwcRaw,
          plantDrWetN: reading.data.plantDrWetN,
          plantDrWetVwcRaw: reading.data.plantDrWetVwcRaw,
          plantDrConfigId: reading.data.plantDrConfigId,
          plantDrNextWateringDate: reading.data.plantDrNextWateringDate,
          plantDrNextEmptyTankDate: reading.data.plantDrNextEmptyTankDate,
          plantDrFullTankAutonomy: reading.data.plantDrFullTankAutonomy,
          calibrationDataBlobHex: reading.data.calibrationDataBlobHex,
          colorRaw: reading.data.colorRaw,
        }
      : {
          tempRaw: reading.data.tempRaw,
          humidityRaw: reading.data.humidityRaw,
          voltageRawMv: reading.data.voltageRawMv,
        };

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.reading.create({ data: { deviceId, source, ...data } });
    await tx.rawSensorLog.create({ data: { readingId: row.id, ...rawData } });
    return row;
  });
  emitReading({ deviceId, kind, reading: serializeReading(created) });

  const mqttState = getMqttState();
  if (mqttState) {
    publishReadingState(mqttState.client, deviceId, data, mqttState.baseTopic);
    void publishHealthState(mqttState.client, deviceId, mqttState.baseTopic);
  }

  return created;
}

// Additive to the existing console `log(...)` call at each of its 3 call sites (scanner.ts's
// pollDeviceNow, devices.ts's sync/forceSyncAll) — never a replacement for it (docs/STROYPLANT_SPEC.md
// section 7.1). A successful sync is never recorded here: the resulting Reading row already proves
// it happened, so only failures are persisted.
//
// Dedup mitigation (2026-07-30, DestCom's explicit choice): a persistently unreachable device would
// otherwise write a near-identical row every ~5min forever, with no retention/purge policy in place
// yet (that broader policy is deliberately deferred to a later, production-data-informed decision —
// not decided here). As a cheap, non-destructive safeguard, skip the insert if the most recent
// SyncEvent for this device has the SAME errorDetail and landed within the last poll interval.
export async function persistSyncFailure(deviceId: string, source: SyncSource, errorDetail: string) {
  const recent = await prisma.syncEvent.findFirst({
    where: { deviceId, timestamp: { gte: new Date(Date.now() - DEFAULT_POLL_INTERVAL_MS) } },
    orderBy: { timestamp: 'desc' },
  });
  if (recent && recent.errorDetail === errorDetail) return;

  await prisma.syncEvent.create({ data: { deviceId, source, errorDetail } });
}
