import { emitReading } from './api/trpc/readingsEmitter.js';
import { serializeReading } from './api/trpc/serialize.js';
import { prisma } from './db/client.js';
import { getMqttState } from './mqtt/manager.js';
import { publishHealthState, publishReadingState } from './mqtt/publisher.js';
import type { DeviceKind, SensorReading } from './providers/types.js';

// Shared by the scanner's automatic poll cycle (ble/scanner.ts, via index.ts's onReading
// callback) and the manual "sync now" tRPC mutation (devices.sync) — a manual sync must
// persist/broadcast a reading identically to an automatic poll, not duplicate this logic (same
// reasoning as triggerWatering() in watering.ts being shared between the manual water mutation and
// the auto-watering scheduler).
export async function persistReading(deviceId: string, kind: DeviceKind, reading: SensorReading) {
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

  const created = await prisma.reading.create({ data: { deviceId, ...data } });
  emitReading({ deviceId, kind, reading: serializeReading(created) });

  const mqttState = getMqttState();
  if (mqttState) {
    publishReadingState(mqttState.client, deviceId, data, mqttState.baseTopic);
    void publishHealthState(mqttState.client, deviceId, mqttState.baseTopic);
  }

  return created;
}
