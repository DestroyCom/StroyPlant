import { readCharacteristic, withDevice, writeCharacteristic } from './ble-client.js';
import { log } from './logger.js';
import { UUIDS, WATER_TRIGGER_PAYLOAD } from './uuids.js';

export interface ParrotSensorReading {
  soilMoisturePercent: number;
  temperatureC: number;
  luminosity: number;
  waterTankLevelPercent?: number;
  soilConductivityRaw?: number;
  lightRaw?: number;
  soilTempRaw?: number;
  airTempRaw?: number;
  soilMoistureRaw?: number;
  isDrySoil?: boolean;
  isWetSoil?: boolean;
  isEmptyTank?: boolean;
  isInAir?: boolean;
}

// Duplicated from backend/src/ble/parrot/plantDr.ts (see uuids.ts header — this process has no
// module sharing with the backend). `HawaiiDevice.parsePlantDrStatusFlags()`,
// docs/PARROT_BLE_DEEP_DIVE.md section 4.
function decodePlantDrStatusFlags(byte: number) {
  return {
    isDrySoil: (byte & 0x01) !== 0,
    isWetSoil: (byte & 0x02) !== 0,
    isEmptyTank: (byte & 0x04) !== 0,
    isInAir: (byte & 0x08) !== 0,
  };
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

    let soilConductivityRaw: number | undefined;
    try {
      const raw = await readCharacteristic(pot, UUIDS.live.soilConductivityRaw, 'Soil conductivity', logicalId);
      soilConductivityRaw = raw.readUInt16LE(0);
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'Soil conductivity indisponible',
        deviceId: logicalId,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    let lightRaw: number | undefined;
    let soilTempRaw: number | undefined;
    let airTempRaw: number | undefined;
    let soilMoistureRaw: number | undefined;
    try {
      lightRaw = (await readCharacteristic(pot, UUIDS.live.lightRaw, 'Light raw', logicalId)).readUInt16LE(0);
      soilTempRaw = (await readCharacteristic(pot, UUIDS.live.soilTempRaw, 'Soil temp raw', logicalId)).readUInt16LE(0);
      airTempRaw = (await readCharacteristic(pot, UUIDS.live.airTempRaw, 'Air temp raw', logicalId)).readUInt16LE(0);
      soilMoistureRaw = (await readCharacteristic(pot, UUIDS.live.soilMoistureRaw, 'Soil moisture raw', logicalId)).readUInt16LE(0);
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'Raw Live-service fields indisponibles',
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

    // Plant Dr STATUS_FLAGS (Batch 6) — best-effort like the conductivity reads above: the
    // Plant Dr service may not exist on every firmware revision, must never fail the reading.
    let statusFlags: ReturnType<typeof decodePlantDrStatusFlags> | undefined;
    try {
      const flagsByte = await readCharacteristic(pot, UUIDS.plantDr.statusFlags, 'Plant Dr STATUS_FLAGS', logicalId);
      statusFlags = decodePlantDrStatusFlags(flagsByte.readUInt8(0));
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'Plant Dr STATUS_FLAGS indisponible',
        deviceId: logicalId,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      soilMoisturePercent: soilMoisture.readFloatLE(0),
      temperatureC: temperature.readFloatLE(0),
      luminosity: luminosity.readFloatLE(0),
      waterTankLevelPercent,
      soilConductivityRaw,
      lightRaw,
      soilTempRaw,
      airTempRaw,
      soilMoistureRaw,
      isDrySoil: statusFlags?.isDrySoil,
      isWetSoil: statusFlags?.isWetSoil,
      isEmptyTank: statusFlags?.isEmptyTank,
      isInAir: statusFlags?.isInAir,
    };
  });
}

export async function triggerParrotWatering(logicalId: string): Promise<void> {
  await withDevice(logicalId, async (pot) => {
    // WRITE_TYPE_DEFAULT on the official app side = write WITH response (withoutResponse=false).
    await writeCharacteristic(pot, UUIDS.watering.trigger, 'Watering trigger', WATER_TRIGGER_PAYLOAD, false, logicalId);
  });
}

export interface PlantDrCalibration {
  dryN: number;
  dryVwcPercent: number;
  wetN: number;
  wetVwcPercent: number;
  configId: number;
}

export interface PlantDrWriteValues {
  dryN: number;
  dryVwcRaw: number;
  wetN: number;
  wetVwcRaw: number;
  configId: number;
}

export async function readParrotPlantDrCalibration(logicalId: string): Promise<PlantDrCalibration> {
  return withDevice(logicalId, async (pot) => {
    const dryN = (await readCharacteristic(pot, UUIDS.plantDr.dryN, 'Plant Dr DRY_N', logicalId)).readUInt16LE(0);
    const dryVwcRaw = (await readCharacteristic(pot, UUIDS.plantDr.dryVwc, 'Plant Dr DRY_VWC', logicalId)).readUInt16LE(0);
    const wetN = (await readCharacteristic(pot, UUIDS.plantDr.wetN, 'Plant Dr WET_N', logicalId)).readUInt16LE(0);
    const wetVwcRaw = (await readCharacteristic(pot, UUIDS.plantDr.wetVwc, 'Plant Dr WET_VWC', logicalId)).readUInt16LE(0);
    const configId = (await readCharacteristic(pot, UUIDS.plantDr.configId, 'Plant Dr CONFIG_ID', logicalId)).readUInt16LE(0);
    return { dryN, dryVwcPercent: dryVwcRaw / 10, wetN, wetVwcPercent: wetVwcRaw / 10, configId };
  });
}

// Order matters (docs/PARROT_BLE_DEEP_DIVE.md section 2): CONFIG_ID is the commit, written last.
// Checksum computation itself lives only in backend/src/ble/parrot/plantDr.ts — this process
// writes exactly the values it's given, no independent computation (avoids the formula drifting
// between the two duplicated codebases).
export async function writeParrotPlantDrCalibration(logicalId: string, values: PlantDrWriteValues): Promise<void> {
  await withDevice(logicalId, async (pot) => {
    const writeU16 = async (uuid: string, value: number, label: string) => {
      const payload = Buffer.alloc(2);
      payload.writeUInt16LE(value & 0xffff, 0);
      await writeCharacteristic(pot, uuid, label, payload, false, logicalId);
    };
    await writeU16(UUIDS.plantDr.dryN, values.dryN, 'Plant Dr DRY_N');
    await writeU16(UUIDS.plantDr.dryVwc, values.dryVwcRaw, 'Plant Dr DRY_VWC');
    await writeU16(UUIDS.plantDr.wetN, values.wetN, 'Plant Dr WET_N');
    await writeU16(UUIDS.plantDr.wetVwc, values.wetVwcRaw, 'Plant Dr WET_VWC');
    await writeU16(UUIDS.plantDr.configId, values.configId, 'Plant Dr CONFIG_ID (commit)');
  });
}
