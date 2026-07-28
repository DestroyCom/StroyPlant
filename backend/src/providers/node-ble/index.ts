import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GattCharacteristic, GattService, Device as NodeBleDevice } from 'node-ble';
import { createBluetooth } from 'node-ble';
import { extractParrotManufacturerPayload } from '../../ble/parrot/advertisement.js';
import { decodePlantDrStatusFlags, type PlantDrCalibration, type PlantDrWriteValues } from '../../ble/parrot/plantDr.js';
import { CONNECT_TIMEOUT_MS, withGattRetry, withTimeout } from '../../ble/parrot/retry.js';
import {
  PARROT_POT_NAME_PREFIX,
  PLANT_DR_SERVICE_UUID,
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

// node-ble's Device AND GattCharacteristic wrappers (node_modules/node-ble/src/BusHelper.js and
// GattCharacteristic.js, verified against the installed 1.13.0 source) both register a D-Bus
// PropertiesChanged match rule the moment any property/method is used — for GattCharacteristic
// that means every single readValue()/writeValue() call, not just notification subscriptions —
// and only ever release it via removeListeners(), which the public API calls exclusively from
// Device.disconnect() / GattCharacteristic.stopNotifications(). Every characteristic obtained via
// getCharacteristic() for a plain read/write (soil/temp/lux/tank/conductivity/statusFlags/
// watering-trigger/Plant-Dr-calibration — none of which are notification-based) was leaking one
// match rule forever with no code path that ever released it. Left unreleased (this one plus the
// scan()/connectDevice() leaks below), production hit BlueZ's dbus-daemon
// max_match_rules_per_connection (512) and crashed the whole process — first found via 12
// consecutive crash-loop restarts (root-caused 2026-07-29), then found AGAIN, more slowly, after
// only fixing the Device-level leak: production survived several minutes of real activity
// (scanning, a full watering cycle) instead of crashing within seconds, but still went down once —
// tracing it against the same installed source showed GattCharacteristic has the identical
// usePropsEvents pattern as Device, just triggered by ordinary sensor reads instead of scan ticks.
function releaseDbusListeners(target: NodeBleDevice | GattCharacteristic): void {
  try {
    (target as unknown as { helper: { removeListeners(): void } }).helper.removeListeners();
  } catch {
    // best-effort — cleanup must never fail a scan tick, a connect attempt, or a sensor read/write
  }
}

// Fetches a characteristic and records it for cleanup in the caller's finally block — every GATT
// read/write path below uses this instead of calling service.getCharacteristic() directly, so no
// characteristic can be added to a read/write sequence without also being released afterward.
async function trackedCharacteristic(service: GattService, uuid: string, tracked: GattCharacteristic[]): Promise<GattCharacteristic> {
  const characteristic = await service.getCharacteristic(uuid);
  tracked.push(characteristic);
  return characteristic;
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
    // stopNotifications() only reaches its own internal listener cleanup if the underlying
    // StopNotify D-Bus call succeeds (node-ble's GattCharacteristic.stopNotifications()) — if the
    // device already dropped off (realistic: this is the Xiaomi path, which routinely times out/
    // GATT-errors in production), that call can throw and the .catch() below only swallows it at
    // our level, leaving the match rule registered. releaseDbusListeners is an idempotent backstop.
    await characteristic.stopNotifications().catch(() => {});
    releaseDbusListeners(characteristic);
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
// the production server under real conditions, as explicitly requested by the spec for this retry pattern.
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
    try {
      await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, 'connect');
    } catch (error) {
      // device.connect() itself registers a PropertiesChanged listener before calling BlueZ's
      // Connect() (node-ble's Device.connect()) — on failure this Device is never returned to a
      // caller's try/finally, so disconnect() (the only public path that releases it) never runs.
      releaseDbusListeners(device);
      throw error;
    }
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
            let device: NodeBleDevice | undefined;
            try {
              device = await adapter.getDevice(mac);
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
            } finally {
              if (device) releaseDbusListeners(device);
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
              // disconnect() only reaches its own internal listener cleanup if the underlying
              // Disconnect D-Bus call succeeds (node-ble's Device.disconnect()) — if the device
              // already dropped off, that call can throw and .catch() below only swallows it at our
              // level, leaving the match rule registered. releaseDbusListeners is an idempotent
              // backstop, safe to call whether or not disconnect()'s own cleanup already ran.
              await device.disconnect().catch(() => {});
              releaseDbusListeners(device);
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
          const characteristics: GattCharacteristic[] = [];
          try {
            const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
            const sensorService = await gatt.getPrimaryService(SENSOR_SERVICE_UUID);

            const measurePeriod = await trackedCharacteristic(sensorService, UUIDS.live.measurePeriod, characteristics);
            await measurePeriod.writeValueWithResponse(Buffer.from([1]));
            log({
              direction: 'WRITE',
              label: 'Activate live measure period',
              uuid: UUIDS.live.measurePeriod,
              deviceId,
              payloadHex: '01',
              result: 'OK',
            });

            const soilChar = await trackedCharacteristic(sensorService, UUIDS.live.soilMoisturePercent, characteristics);
            const tempChar = await trackedCharacteristic(sensorService, UUIDS.live.temperatureC, characteristics);
            const luxChar = await trackedCharacteristic(sensorService, UUIDS.live.luminosity, characteristics);
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
              const tankChar = await trackedCharacteristic(wateringService, UUIDS.watering.waterTankLevel, characteristics);
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
              const ecbChar = await trackedCharacteristic(sensorService, UUIDS.live.soilConductivityEcb, characteristics);
              soilConductivityEcb = (await ecbChar.readValue()).readFloatLE(0);
              const ecPorousChar = await trackedCharacteristic(sensorService, UUIDS.live.soilConductivityEcPorous, characteristics);
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

            // Plant Dr STATUS_FLAGS (Batch 6) — best-effort like the conductivity reads above: the
            // Plant Dr service may not exist on every firmware revision, must never fail the read.
            let statusFlags: ReturnType<typeof decodePlantDrStatusFlags> | undefined;
            try {
              const plantDrService = await gatt.getPrimaryService(PLANT_DR_SERVICE_UUID);
              const statusFlagsChar = await trackedCharacteristic(plantDrService, UUIDS.plantDr.statusFlags, characteristics);
              statusFlags = decodePlantDrStatusFlags((await statusFlagsChar.readValue()).readUInt8(0));
              log({
                direction: 'READ',
                label: 'Plant Dr STATUS_FLAGS read',
                deviceId,
                result: 'OK',
                detail: JSON.stringify(statusFlags),
              });
            } catch (error) {
              log({
                direction: 'INFO',
                label: 'Plant Dr STATUS_FLAGS indisponible',
                deviceId,
                result: 'ERROR',
                detail: error instanceof Error ? error.message : String(error),
              });
            }

            const reading: SensorReading = {
              kind: 'PARROT_POT',
              data: {
                soilMoisturePercent: soilMoisture.readFloatLE(0),
                temperatureC: temperature.readFloatLE(0),
                luminosity: luminosity.readFloatLE(0),
                waterTankLevelPercent,
                soilConductivityEcb,
                soilConductivityEcPorous,
                isDrySoil: statusFlags?.isDrySoil,
                isWetSoil: statusFlags?.isWetSoil,
                isEmptyTank: statusFlags?.isEmptyTank,
                isInAir: statusFlags?.isInAir,
              },
            };
            return reading;
          } finally {
            for (const characteristic of characteristics) releaseDbusListeners(characteristic);
            // disconnect() only reaches its own internal listener cleanup if the underlying
            // Disconnect D-Bus call succeeds (node-ble's Device.disconnect()) — if the device
            // already dropped off, that call can throw and .catch() below only swallows it at our
            // level, leaving the match rule registered. releaseDbusListeners is an idempotent
            // backstop, safe to call whether or not disconnect()'s own cleanup already ran.
            await device.disconnect().catch(() => {});
            releaseDbusListeners(device);
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
          const characteristics: GattCharacteristic[] = [];
          try {
            const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
            const wateringService = await gatt.getPrimaryService(WATERING_SERVICE_UUID);
            const trigger = await trackedCharacteristic(wateringService, UUIDS.watering.trigger, characteristics);
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
            for (const characteristic of characteristics) releaseDbusListeners(characteristic);
            // disconnect() only reaches its own internal listener cleanup if the underlying
            // Disconnect D-Bus call succeeds (node-ble's Device.disconnect()) — if the device
            // already dropped off, that call can throw and .catch() below only swallows it at our
            // level, leaving the match rule registered. releaseDbusListeners is an idempotent
            // backstop, safe to call whether or not disconnect()'s own cleanup already ran.
            await device.disconnect().catch(() => {});
            releaseDbusListeners(device);
          }
        },
      });
    },

    async readPlantDrCalibration(deviceId: string): Promise<PlantDrCalibration> {
      return withGattRetry({
        label: 'readPlantDrCalibration',
        deviceId,
        isGattError133,
        restartAdapter,
        attempt: async () => {
          const device = await connectDevice(deviceId);
          const characteristics: GattCharacteristic[] = [];
          try {
            const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
            const plantDrService = await gatt.getPrimaryService(PLANT_DR_SERVICE_UUID);
            const readU16 = async (uuid: string) =>
              (await (await trackedCharacteristic(plantDrService, uuid, characteristics)).readValue()).readUInt16LE(0);

            const dryN = await readU16(UUIDS.plantDr.dryN);
            const dryVwcRaw = await readU16(UUIDS.plantDr.dryVwc);
            const wetN = await readU16(UUIDS.plantDr.wetN);
            const wetVwcRaw = await readU16(UUIDS.plantDr.wetVwc);
            const configId = await readU16(UUIDS.plantDr.configId);

            const calibration: PlantDrCalibration = {
              dryN,
              dryVwcPercent: dryVwcRaw / 10,
              wetN,
              wetVwcPercent: wetVwcRaw / 10,
              configId,
            };
            log({ direction: 'READ', label: 'Plant Dr calibration read', deviceId, result: 'OK', detail: JSON.stringify(calibration) });
            return calibration;
          } finally {
            for (const characteristic of characteristics) releaseDbusListeners(characteristic);
            // disconnect() only reaches its own internal listener cleanup if the underlying
            // Disconnect D-Bus call succeeds (node-ble's Device.disconnect()) — if the device
            // already dropped off, that call can throw and .catch() below only swallows it at our
            // level, leaving the match rule registered. releaseDbusListeners is an idempotent
            // backstop, safe to call whether or not disconnect()'s own cleanup already ran.
            await device.disconnect().catch(() => {});
            releaseDbusListeners(device);
          }
        },
      });
    },

    async writePlantDrCalibration(deviceId: string, values: PlantDrWriteValues): Promise<void> {
      await withGattRetry({
        label: 'writePlantDrCalibration',
        deviceId,
        isGattError133,
        restartAdapter,
        attempt: async () => {
          const device = await connectDevice(deviceId);
          const characteristics: GattCharacteristic[] = [];
          try {
            const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
            const plantDrService = await gatt.getPrimaryService(PLANT_DR_SERVICE_UUID);

            const writeU16 = async (uuid: string, value: number, label: string) => {
              const characteristic = await trackedCharacteristic(plantDrService, uuid, characteristics);
              const payload = Buffer.alloc(2);
              payload.writeUInt16LE(value & 0xffff, 0);
              await characteristic.writeValueWithResponse(payload);
              log({ direction: 'WRITE', label, uuid, deviceId, payloadHex: payload.toString('hex'), result: 'OK' });
            };

            // Order matters (docs/PARROT_BLE_DEEP_DIVE.md section 2): CONFIG_ID is the commit,
            // written last.
            await writeU16(UUIDS.plantDr.dryN, values.dryN, 'Plant Dr DRY_N');
            await writeU16(UUIDS.plantDr.dryVwc, values.dryVwcRaw, 'Plant Dr DRY_VWC');
            await writeU16(UUIDS.plantDr.wetN, values.wetN, 'Plant Dr WET_N');
            await writeU16(UUIDS.plantDr.wetVwc, values.wetVwcRaw, 'Plant Dr WET_VWC');
            await writeU16(UUIDS.plantDr.configId, values.configId, 'Plant Dr CONFIG_ID (commit)');
          } finally {
            for (const characteristic of characteristics) releaseDbusListeners(characteristic);
            // disconnect() only reaches its own internal listener cleanup if the underlying
            // Disconnect D-Bus call succeeds (node-ble's Device.disconnect()) — if the device
            // already dropped off, that call can throw and .catch() below only swallows it at our
            // level, leaving the match rule registered. releaseDbusListeners is an idempotent
            // backstop, safe to call whether or not disconnect()'s own cleanup already ran.
            await device.disconnect().catch(() => {});
            releaseDbusListeners(device);
          }
        },
      });
    },
  };
}
