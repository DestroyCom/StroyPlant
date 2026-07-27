import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GattCharacteristic } from 'node-ble';
import { createBluetooth } from 'node-ble';
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

const XIAOMI_NOTIFY_TIMEOUT_MS = 15000;

// Le LYWSD03MMC (contrairement au Parrot Pot) ne se lit pas par un simple readValue() — il faut
// souscrire aux notifications sur ebe0ccc1 et attendre la première valeur (validé empiriquement sur
// device réel, voir backend/src/ble/xiaomi/uuids.ts).
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

// Cycle de scan (STROYPLANT_SPEC.md section 7.1) : ~10s de scan puis pause (1 min en usage normal),
// filtré par RSSI minimum -90. La notion de "vu depuis 3 cycles avant d'être déclaré perdu" est gérée
// au niveau du scanner orchestrateur (backend/src/ble/scanner.ts), pas ici — ce provider ne fait
// que remonter des événements de découverte bruts.
const SCAN_WINDOW_MS = 10_000;
const SCAN_PAUSE_MS = 60_000;
const RSSI_MIN = -90;

// BlueZ n'a pas d'équivalent 1:1 du code Android/Bluedroid GATT_ERROR=133 (voir
// PARROT_BLE_DEEP_DIVE.md section 5 : ce sont des codes Android, pas un standard bas niveau). Cette
// heuristique reste donc du best-effort sur les messages d'erreur D-Bus les plus proches
// fonctionnellement (échec de connexion générique post-déconnexion) — À AFFINER EMPIRIQUEMENT sur
// l'the production server en conditions réelles, comme demandé explicitement par la spec pour ce pattern de retry.
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

  // disable()/enable() ne sont pas exposés par node-ble — on passe par bluetoothctl (nécessite le
  // paquet bluez dans l'image Docker, en plus de l'accès D-Bus déjà requis). Équivalent fonctionnel
  // de "Powered: false" puis "Powered: true" sur l'adaptateur, avec attente jusqu'à 60s (spec 7.1).
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
    throw new Error("Adaptateur toujours 'not powered' après 60s de redémarrage");
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
              onDiscovered({ id: mac, kind, name, rssi });
            } catch {
              // le device peut disparaître entre devices() et getDevice() — pas une erreur à remonter
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

            await measurePeriod.writeValueWithResponse(Buffer.from([0])).catch(() => {});

            const reading: SensorReading = {
              kind: 'PARROT_POT',
              data: {
                soilMoisturePercent: soilMoisture.readFloatLE(0),
                temperatureC: temperature.readFloatLE(0),
                luminosity: luminosity.readFloatLE(0),
                waterTankLevelPercent,
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
      if (action !== 'water') throw new Error(`Action non supportée: ${action}`);
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
