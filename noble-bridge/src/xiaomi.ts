import { subscribeAndWaitForFirstValue, withDevice } from './ble-client.js';
import { log } from './logger.js';
import { XIAOMI_TEMP_HUMIDITY_CHARACTERISTIC_UUID } from './uuids.js';

export interface XiaomiSensorReading {
  temperatureC: number;
  humidityPercent: number;
  batteryPercent: number;
}

const NOTIFY_TIMEOUT_MS = 15000;

// Formule confirmée par WatchFlower (device_hygrotemp_square.cpp) ET revalidée empiriquement sur le
// vrai device (voir backend/src/ble/xiaomi/parser.ts pour le détail) : 5 octets =
// [int16 LE temp/100][uint8 humidity][int16 LE tension mV/1000].
function parseTempHumidityPayload(buf: Buffer): XiaomiSensorReading {
  if (buf.length !== 5) {
    throw new Error(`Payload temp/humidity Xiaomi de taille inattendue: ${buf.length} octet(s) (5 attendus)`);
  }
  const temperatureC = buf.readInt16LE(0) / 100;
  const humidityPercent = buf.readUInt8(2);
  const voltage = buf.readInt16LE(3) / 1000;
  const batteryPercent = Math.min(100, Math.max(0, Math.round((voltage - 2.1) * 100)));
  return { temperatureC, humidityPercent, batteryPercent };
}

export async function readXiaomiSensors(logicalId: string): Promise<XiaomiSensorReading> {
  return withDevice(logicalId, async (device) => {
    const payload = await subscribeAndWaitForFirstValue(
      device,
      XIAOMI_TEMP_HUMIDITY_CHARACTERISTIC_UUID,
      'Xiaomi temp/humidity',
      logicalId,
      NOTIFY_TIMEOUT_MS,
    );
    const reading = parseTempHumidityPayload(payload);
    log({
      direction: 'READ',
      label: 'Xiaomi temp/humidity read',
      deviceId: logicalId,
      uuid: XIAOMI_TEMP_HUMIDITY_CHARACTERISTIC_UUID,
      payloadHex: payload.toString('hex'),
      result: 'OK',
      detail: `temp=${reading.temperatureC}°C humidity=${reading.humidityPercent}%`,
    });
    return reading;
  });
}
