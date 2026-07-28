import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GattCharacteristic, Device as NodeBleDevice } from 'node-ble';
import { createBluetooth } from 'node-ble';
import { extractParrotManufacturerPayload } from '../../ble/parrot/advertisement.js';
import { CONNECT_TIMEOUT_MS, withGattRetry, withTimeout } from '../../ble/parrot/retry.js';
import {
  PARROT_POT_NAME_PREFIX,
  SENSOR_SERVICE_UUID,
  UUIDS,
  WATER_TRIGGER_PAYLOAD,
  WATERING_SERVICE_UUID,
} from '../../ble/parrot/uuids.js';
import { parseTempHumidityPayload } from '../../ble/xiaomi/parser.js';
import {
  LYWSD03MMC_NAME,
  TEMP_HUMIDITY_CHARACTERISTIC_UUID,
  DATA_SERVICE_UUID as XIAOMI_DATA_SERVICE_UUID,
} from '../../ble/xiaomi/uuids.js';
import { log } from '../../logger.js';
import type { DeviceProvider, SensorReading } from '../types.js';

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Raw payload only — NO bit-level interpretation as long as the correlation protocol
// (docs/STROYPLANT_SPEC.md section 7.1) hasn't produced a reproducible result (requires physical
// access to the devices, not done yet). Must never fail device discovery if
// unavailable/absent.
async function readParrotAdvertisementPayload(device: NodeBleDevice): Promise<string | undefined> {
  try {
    const manufacturerData = await device.getManufacturerData();
    const payload = extractParrotManufacturerPayload(manufacturerData);
    return payload?.toString('hex');
  } catch {
    return undefined;
  }
}

const XIAOMI_NOTIFY_TIMEOUT_MS = 15000;

// The LYWSD03MMC (unlike the Parrot Pot) can't be read with a simple readValue() — you have to
// subscribe to notifications on ebe0ccc1 and wait for the first value (validated empirically on
// a real device, see backend/src/ble/xiaomi/uuids.ts).
async function waitForFirstNotification(characteristic: GattCharacteristic, timeoutMs: number): Promise<Buffer> {
  await characteristic.startNotifications();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        characteristic.removeListener('valuechanged', onValue);
        reject(new Error(`TIMEOUT: notification LYWSD03MMC (${timeoutMs}ms)`));
      }, timeoutMs);
      function onValue(buf: Buffer) {
        clearTimeout(timeoutHandle);
        characteristic.removeListener('valuechanged', onValue);
        resolve(buf);
      }
      characteristic.on('valuechanged', onValue);
    });
  } finally {
    await characteristic.stopNotifications().catch(() => {});
  }
}

// Scan cycle (docs/STROYPLANT_SPEC.md section 7.1): ~10s of scanning then a pause (1 min in normal
// use), filtered by a minimum RSSI of -90. The "seen for 3 cycles before being declared lost"
// notion is handled at the orchestrating scanner level (backend/src/ble/scanner.ts), not here —
// this provider only surfaces raw discovery events.
const SCAN_WINDOW_MS = 10_000;
const SCAN_PAUSE_MS = 60_000;
const RSSI_MIN = -90;

// BlueZ has no 1:1 equivalent of the Android/Bluedroid GATT_ERROR=133 code (see
// docs/PARROT_BLE_DEEP_DIVE.md section 5: these are Android codes, not a low-level standard). This
// heuristic therefore remains best-effort on the D-Bus error messages closest
// functionally (generic connection failure post-disconnection) — TO BE REFINED EMPIRICALLY on
// the the production server under real conditions, as explicitly requested by the spec for this retry pattern.
function isGattError133(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes('software caused connection abort') ||
    msg.includes('connection abort') ||
    msg.includes('le-connection-abort-by-local') ||
    msg.includes('connection attempt failed') ||
    msg.includes('br-connection-canceled') ||
    msg.includes('device or resource busy')
  );
}

export function createNodeBleProvider(): DeviceProvider {
  const { bluetooth } = createBluetooth();

  async function getAdapter() {
    return bluetooth.defaultAdapter();
  }

  // disable()/enable() aren't exposed by node-ble — we go through bluetoothctl (requires the
  // bluez package in the Docker image, in addition to the D-Bus access already required). Functional
  // equivalent of "Powered: false" then "Powered: true" on the adapter, with up to 60s wait (spec 7.1).
  async function restartAdapter(): Promise<void> {
    await execFileAsync('bluetoothctl', ['power', 'off']);
    await sleep(2000);
    await execFileAsync('bluetoothctl', ['power', 'on']);
    const adapter = await getAdapter();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await adapter.isPowered()) return;
      await sleep(1000);
    }
    throw new Error("Adapter still 'not powered' after 60s restart");
  }

  async function connectDevice(macAddress: string) {
    const adapter = await getAdapter();
    if (!(await adapter.isDiscovering())) await adapter.startDiscovery().catch(() => {});
    const device = await withTimeout(adapter.waitDevice(macAddress, CONNECT_TIMEOUT_MS), CONNECT_TIMEOUT_MS + 2000, 'waitDevice');
    await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, 'connect');
    return device;
  }

  return {
    name: 'node-ble',

    async scan(onDiscovered, signal) {
      const adapter = await getAdapter();

      while (!signal.aborted) {
        if (!(await adapter.isDiscovering())) await adapter.startDiscovery();

        const cycleDeadline = Date.now() + SCAN_WINDOW_MS;
        while (Date.now() < cycleDeadline && !signal.aborted) {
          const macs = await adapter.devices();
          for (const mac of macs) {
            try {
              const device = await adapter.getDevice(mac);
              const name = await device.getName().catch(() => undefined);
              const kind = name?.startsWith(PARROT_POT_NAME_PREFIX)
                ? 'PARROT_POT'
                : name === LYWSD03MMC_NAME
                  ? 'XIAOMI_LYWSD03MMC'
                  : undefined;
              if (!kind) continue;
              const rssiRaw = await device.getRSSI().catch(() => undefined);
              const rssi = rssiRaw !== undefined ? Number(rssiRaw) : undefined;
              if (rssi !== undefined && rssi < RSSI_MIN) continue;

              // Diagnostics only — raw payload, not interpreted (docs/STROYPLANT_SPEC.md
              // section 7.1, correlation protocol not executed yet).
              const advertisementPayloadHex = kind === 'PARROT_POT' ? await readParrotAdvertisementPayload(device) : undefined;
              if (advertisementPayloadHex) {
                log({
                  direction: 'SCAN',
                  label: 'Parrot advertisement manufacturer data (diagnostic, not interpreted)',
                  deviceId: mac,
                  result: 'OK',
                  detail: advertisementPayloadHex,
                });
              }

              onDiscovered({ id: mac, kind, name, rssi, advertisementPayloadHex });
            } catch {
              // the device can disappear between devices() and getDevice() — not an error to report
            }
          }
          await sleep(1000);
        }

        if (await adapter.isDiscovering()) await adapter.stopDiscovery().catch(() => {});
        if (signal.aborted) break;
        await sleep(SCAN_PAUSE_MS);
      }
    },

    async readSensors(deviceId: string, kind): Promise<SensorReading> {
      if (kind === 'XIAOMI_LYWSD03MMC') {
        return withGattRetry({
          label: 'readSensors:xiaomi',
          deviceId,
          isGattError133,
          restartAdapter,
          attempt: async () => {
            const device = await connectDevice(deviceId);
            try {
              const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
              const dataService = await gatt.getPrimaryService(XIAOMI_DATA_SERVICE_UUID);
              const tempHumidityChar = await dataService.getCharacteristic(TEMP_HUMIDITY_CHARACTERISTIC_UUID);
              const payload = await waitForFirstNotification(tempHumidityChar, XIAOMI_NOTIFY_TIMEOUT_MS);
              const data = parseTempHumidityPayload(payload);
              log({
                direction: 'READ',
                label: 'Xiaomi temp/humidity read',
                deviceId,
                payloadHex: payload.toString('hex'),
                result: 'OK',
                detail: `temp=${data.temperatureC}°C humidity=${data.humidityPercent}%`,
              });
              const reading: SensorReading = { kind: 'XIAOMI_LYWSD03MMC', data };
              return reading;
            } finally {
              await device.disconnect().catch(() => {});
            }
          },
        });
      }

      return withGattRetry({
        label: 'readSensors',
        deviceId,
        isGattError133,
        restartAdapter,
        attempt: async () => {
          const device = await connectDevice(deviceId);
          try {
            const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
            const sensorService = await gatt.getPrimaryService(SENSOR_SERVICE_UUID);

            const measurePeriod = await sensorService.getCharacteristic(UUIDS.live.measurePeriod);
            await measurePeriod.writeValueWithResponse(Buffer.from([1]));
            log({
              direction: 'WRITE',
              label: 'Activate live measure period',
              uuid: UUIDS.live.measurePeriod,
              deviceId,
              payloadHex: '01',
              result: 'OK',
            });

            const soilChar = await sensorService.getCharacteristic(UUIDS.live.soilMoisturePercent);
            const tempChar = await sensorService.getCharacteristic(UUIDS.live.temperatureC);
            const luxChar = await sensorService.getCharacteristic(UUIDS.live.luminosity);
            const soilMoisture = await soilChar.readValue();
            const temperature = await tempChar.readValue();
            const luminosity = await luxChar.readValue();
            log({
              direction: 'READ',
              label: 'Sensors read',
              deviceId,
              result: 'OK',
              detail: `soil=${soilMoisture.toString('hex')} temp=${temperature.toString('hex')} lux=${luminosity.toString('hex')}`,
            });

            let waterTankLevelPercent: number | undefined;
            try {
              const wateringService = await gatt.getPrimaryService(WATERING_SERVICE_UUID);
              const tankChar = await wateringService.getCharacteristic(UUIDS.watering.waterTankLevel);
              waterTankLevelPercent = (await tankChar.readValue()).readUInt8(0);
            } catch (error) {
              log({
                direction: 'INFO',
                label: 'Water tank level indisponible',
                deviceId,
                result: 'ERROR',
                detail: error instanceof Error ? error.message : String(error),
              });
            }

            // Conductivity candidates (39e1fa0d/0e) — never used by the official Parrot Pot app,
            // firmware behavior not guaranteed. Read best-effort: a failure here must never
            // fail the main sensor reading (docs/STROYPLANT_SPEC.md section 8).
            let soilConductivityEcb: number | undefined;
            let soilConductivityEcPorous: number | undefined;
            try {
              const ecbChar = await sensorService.getCharacteristic(UUIDS.live.soilConductivityEcb);
              soilConductivityEcb = (await ecbChar.readValue()).readFloatLE(0);
              const ecPorousChar = await sensorService.getCharacteristic(UUIDS.live.soilConductivityEcPorous);
              soilConductivityEcPorous = (await ecPorousChar.readValue()).readFloatLE(0);
              log({
                direction: 'READ',
                label: 'Soil conductivity (Ecb/Ec porous) read',
                deviceId,
                result: 'OK',
                detail: `ecb=${soilConductivityEcb} ecPorous=${soilConductivityEcPorous}`,
              });
            } catch (error) {
              log({
                direction: 'INFO',
                label: 'Soil conductivity (Ecb/Ec porous) indisponible',
                deviceId,
                result: 'ERROR',
                detail: error instanceof Error ? error.message : String(error),
              });
            }

            await measurePeriod.writeValueWithResponse(Buffer.from([0])).catch(() => {});

            const reading: SensorReading = {
              kind: 'PARROT_POT',
              data: {
                soilMoisturePercent: soilMoisture.readFloatLE(0),
                temperatureC: temperature.readFloatLE(0),
                luminosity: luminosity.readFloatLE(0),
                waterTankLevelPercent,
                soilConductivityEcb,
                soilConductivityEcPorous,
              },
            };
            return reading;
          } finally {
            await device.disconnect().catch(() => {});
          }
        },
      });
    },

    async triggerAction(deviceId: string, action): Promise<void> {
      if (action !== 'water') throw new Error(`Unsupported action: ${action}`);
      await withGattRetry({
        label: 'triggerAction:water',
        deviceId,
        isGattError133,
        restartAdapter,
        attempt: async () => {
          const device = await connectDevice(deviceId);
          try {
            const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
            const wateringService = await gatt.getPrimaryService(WATERING_SERVICE_UUID);
            const trigger = await wateringService.getCharacteristic(UUIDS.watering.trigger);
            await trigger.writeValueWithResponse(WATER_TRIGGER_PAYLOAD);
            log({
              direction: 'WRITE',
              label: 'Watering trigger',
              uuid: UUIDS.watering.trigger,
              deviceId,
              payloadHex: WATER_TRIGGER_PAYLOAD.toString('hex'),
              result: 'OK',
            });
          } finally {
            await device.disconnect().catch(() => {});
          }
        },
      });
    },
  };
}
