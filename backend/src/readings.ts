import type { ReadingSource, SyncSource } from '@prisma/client';
import { emitReading } from './api/trpc/readingsEmitter.js';
import { serializeReading } from './api/trpc/serialize.js';
import { prisma } from './db/client.js';
import { getMqttState } from './mqtt/manager.js';
import { publishHealthState, publishReadingState } from './mqtt/publisher.js';
import type { DeviceKind, SensorReading } from './providers/types.js';

// Shared by the scanner's automatic poll cycle (ble/scanner.ts, via index.ts's onReading
// callback), the manual "sync now"/"forcer la synchro" tRPC mutations (devices.sync/forceSyncAll),
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
          soilConductivityEcb: reading.data.soilConductivityEcb,
          soilConductivityEcPorous: reading.data.soilConductivityEcPorous,
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

  const created = await prisma.reading.create({ data: { deviceId, source, ...data } });
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
export async function persistSyncFailure(deviceId: string, source: SyncSource, errorDetail: string) {
  await prisma.syncEvent.create({ data: { deviceId, source, errorDetail } });
}
