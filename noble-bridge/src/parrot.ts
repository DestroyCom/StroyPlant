import { connectAndDiscover, disconnect, readCharacteristic, scanForParrotPot, writeCharacteristic } from './ble-client.js';
import { log } from './logger.js';
import { UUIDS, WATER_TRIGGER_PAYLOAD } from './uuids.js';

export interface ParrotSensorReading {
  soilMoisturePercent: number;
  temperatureC: number;
  luminosity: number;
  waterTankLevelPercent?: number;
}

async function withPot<T>(logicalId: string, work: (pot: Awaited<ReturnType<typeof connectAndDiscover>>) => Promise<T>): Promise<T> {
  const peripheral = await scanForParrotPot(logicalId);
  if (!peripheral) throw new Error(`Parrot Pot ${logicalId} non trouvé au scan`);
  const pot = await connectAndDiscover(peripheral, logicalId);
  try {
    return await work(pot);
  } finally {
    await disconnect(peripheral, logicalId).catch(() => {});
  }
}

// Prérequis d'activation obligatoire (STROYPLANT_SPEC.md section 8) : sans ce write, le firmware
// ne rafraîchit pas fa09/0a/0b en continu — un read() renvoie la dernière valeur en mémoire,
// potentiellement figée depuis très longtemps, sans aucune erreur associée.
export async function readParrotSensors(logicalId: string): Promise<ParrotSensorReading> {
  return withPot(logicalId, async (pot) => {
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

    // Écrire 0 en fin de session pour économiser la batterie côté firmware quand aucun client
    // n'écoute (STROYPLANT_SPEC.md section 8). Ne doit pas faire échouer la lecture si ça échoue.
    await writeCharacteristic(pot, UUIDS.live.measurePeriod, 'Deactivate live measure period', Buffer.from([0]), false, logicalId).catch(
      () => {},
    );

    return {
      soilMoisturePercent: soilMoisture.readFloatLE(0),
      temperatureC: temperature.readFloatLE(0),
      luminosity: luminosity.readFloatLE(0),
      waterTankLevelPercent,
    };
  });
}

export async function triggerParrotWatering(logicalId: string): Promise<void> {
  await withPot(logicalId, async (pot) => {
    // WRITE_TYPE_DEFAULT côté app officielle = write WITH response (withoutResponse=false).
    await writeCharacteristic(pot, UUIDS.watering.trigger, 'Watering trigger', WATER_TRIGGER_PAYLOAD, false, logicalId);
  });
}
