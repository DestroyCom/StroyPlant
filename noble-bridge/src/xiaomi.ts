import { subscribeAndWaitForFirstValue, withDevice } from './ble-client.js';
import { log } from './logger.js';
import { XIAOMI_TEMP_HUMIDITY_CHARACTERISTIC_UUID } from './uuids.js';

export interface XiaomiSensorReading {
  temperatureC: number;
  humidityPercent: number;
  batteryPercent: number;
  // Raw sensor debug log (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-
  // and-raw-sensor-log-design.md) — mirrors backend/src/ble/xiaomi/parser.ts's own extension, kept
  // in sync manually since this package doesn't share code with the backend.
  tempRaw: number;
  humidityRaw: number;
  voltageRawMv: number;
}

const NOTIFY_TIMEOUT_MS = 15000;

// Formula confirmed by WatchFlower (device_hygrotemp_square.cpp) AND revalidated empirically on
// the real device (see backend/src/ble/xiaomi/parser.ts for detail): 5 bytes =
// [int16 LE temp/100][uint8 humidity][int16 LE voltage mV/1000].
function parseTempHumidityPayload(buf: Buffer): XiaomiSensorReading {
  if (buf.length !== 5) {
    throw new Error(`Payload temp/humidity Xiaomi de taille inattendue: ${buf.length} octet(s) (5 attendus)`);
  }
  const tempRaw = buf.readInt16LE(0);
  const humidityRaw = buf.readUInt8(2);
  const voltageRawMv = buf.readInt16LE(3);
  const temperatureC = tempRaw / 100;
  const humidityPercent = humidityRaw;
  const voltage = voltageRawMv / 1000;
  const batteryPercent = Math.min(100, Math.max(0, Math.round((voltage - 2.1) * 100)));
  return { temperatureC, humidityPercent, batteryPercent, tempRaw, humidityRaw, voltageRawMv };
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
