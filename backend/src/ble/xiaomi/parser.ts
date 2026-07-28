import type { XiaomiReading } from '../../providers/types.js';

// Formula confirmed by WatchFlower (device_hygrotemp_square.cpp bleReadNotify) AND revalidated
// empirically on the real device (real payloads 3e 0a 2d 88 0b / 3b 0a 2c 88 0b -> ~26.2°C,
// 44-45%, ~85% battery, consistent values). 5 bytes: [int16 LE temp/100][uint8 humidity][int16 LE
// voltage mV/1000].
export function parseTempHumidityPayload(buf: Buffer): XiaomiReading {
  if (buf.length !== 5) {
    throw new Error(`Payload temp/humidity Xiaomi de taille inattendue: ${buf.length} octet(s) (5 attendus)`);
  }
  const temperatureC = buf.readInt16LE(0) / 100;
  const humidityPercent = buf.readUInt8(2);
  const voltage = buf.readInt16LE(3) / 1000;
  const batteryPercent = Math.min(100, Math.max(0, Math.round((voltage - 2.1) * 100)));
  return { temperatureC, humidityPercent, batteryPercent };
}
