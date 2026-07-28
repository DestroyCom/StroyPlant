import { readCharacteristic, withDevice, writeCharacteristic } from './ble-client.js';
import { log } from './logger.js';
import { UUIDS, WATER_TRIGGER_PAYLOAD } from './uuids.js';

export interface ParrotSensorReading {
  soilMoisturePercent: number;
  temperatureC: number;
  luminosity: number;
  waterTankLevelPercent?: number;
  soilConductivityEcb?: number;
  soilConductivityEcPorous?: number;
}

// Mandatory activation prerequisite (docs/STROYPLANT_SPEC.md section 8): without this write, the
// firmware doesn't continuously refresh fa09/0a/0b — a read() returns the last value in memory,
// potentially stale for a very long time, with no associated error.
export async function readParrotSensors(logicalId: string): Promise<ParrotSensorReading> {
  return withDevice(logicalId, async (pot) => {
    await writeCharacteristic(pot, UUIDS.live.measurePeriod, 'Activate live measure period', Buffer.from([1]), false, logicalId);

    const soilMoisture = await readCharacteristic(pot, UUIDS.live.soilMoisturePercent, 'Soil moisture (calibrated)', logicalId);
    const temperature = await readCharacteristic(pot, UUIDS.live.temperatureC, 'Temperature (calibrated)', logicalId);
    const luminosity = await readCharacteristic(pot, UUIDS.live.luminosity, 'Luminosity (calibrated)', logicalId);

    let waterTankLevelPercent: number | undefined;
    try {
      const tank = await readCharacteristic(pot, UUIDS.watering.waterTankLevel, 'Water tank level', logicalId);
      waterTankLevelPercent = tank.readUInt8(0);
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'Water tank level indisponible',
        deviceId: logicalId,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // "Soil conductivity" candidates (docs/STROYPLANT_SPEC.md section 8) — never used by the
    // official Parrot Pot app, firmware behavior not guaranteed. Best-effort: a failure here must
    // never fail the reading of the main sensors.
    let soilConductivityEcb: number | undefined;
    let soilConductivityEcPorous: number | undefined;
    try {
      const ecb = await readCharacteristic(pot, UUIDS.live.soilConductivityEcb, 'Soil conductivity (Ecb)', logicalId);
      const ecPorous = await readCharacteristic(pot, UUIDS.live.soilConductivityEcPorous, 'Soil conductivity (Ec porous)', logicalId);
      soilConductivityEcb = ecb.readFloatLE(0);
      soilConductivityEcPorous = ecPorous.readFloatLE(0);
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'Soil conductivity (Ecb/Ec porous) indisponible',
        deviceId: logicalId,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // Write 0 at the end of the session to save battery on the firmware side when no client is
    // listening (docs/STROYPLANT_SPEC.md section 8). Must not fail the reading if this fails.
    await writeCharacteristic(pot, UUIDS.live.measurePeriod, 'Deactivate live measure period', Buffer.from([0]), false, logicalId).catch(
      () => {},
    );

    return {
      soilMoisturePercent: soilMoisture.readFloatLE(0),
      temperatureC: temperature.readFloatLE(0),
      luminosity: luminosity.readFloatLE(0),
      waterTankLevelPercent,
      soilConductivityEcb,
      soilConductivityEcPorous,
    };
  });
}

export async function triggerParrotWatering(logicalId: string): Promise<void> {
  await withDevice(logicalId, async (pot) => {
    // WRITE_TYPE_DEFAULT on the official app side = write WITH response (withoutResponse=false).
    await writeCharacteristic(pot, UUIDS.watering.trigger, 'Watering trigger', WATER_TRIGGER_PAYLOAD, false, logicalId);
  });
}
