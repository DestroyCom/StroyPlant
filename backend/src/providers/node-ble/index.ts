import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GattCharacteristic, GattService, Device as NodeBleDevice } from 'node-ble';
import { createBluetooth } from 'node-ble';
import { extractParrotManufacturerPayload } from '../../ble/parrot/advertisement.js';
import { decodePlantDrStatusFlags, type PlantDrCalibration, type PlantDrWriteValues } from '../../ble/parrot/plantDr.js';
import { CONNECT_TIMEOUT_MS, GATT_133_BACKOFF_MS, withGattRetry, withTimeout } from '../../ble/parrot/retry.js';
import { readSoilConductivityRawValue } from '../../ble/parrot/soilConductivity.js';
import {
  CALIBRATION_SERVICE_UUID,
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

// Generic best-effort characteristic read for the raw sensor debug log — every one of these must
// never fail the rest of the poll (spec 7.1), so failures are caught and logged individually here
// rather than repeating the same try/catch at every call site.
async function readRawBestEffort<T>(
  service: GattService,
  uuid: string,
  characteristics: GattCharacteristic[],
  deviceId: string,
  label: string,
  decode: (buf: Buffer) => T,
): Promise<T | undefined> {
  try {
    const characteristic = await trackedCharacteristic(service, uuid, characteristics);
    const value = decode(await characteristic.readValue());
    log({ direction: 'READ', label, deviceId, result: 'OK', detail: String(value) });
    return value;
  } catch (error) {
    log({
      direction: 'INFO',
      label: `${label} indisponible`,
      deviceId,
      result: 'ERROR',
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

const readU16 = (buf: Buffer) => buf.readUInt16LE(0);
const readU8 = (buf: Buffer) => buf.readUInt8(0);
const readU32 = (buf: Buffer) => buf.readUInt32LE(0);

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

// The 3 Parrot Pot live characteristics (soil/temp/lux) notify independently, not in lockstep —
// this debounce combines whatever's most recently known into one combined sample instead of
// persisting 3x/second with 2 stale fields each time (see subscribeLive below).
const LIVE_SAMPLE_DEBOUNCE_MS = 150;

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
// notion is handled at the orchestrating level (backend/src/ble/discoverySession.ts), not here —
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

  // Set while a discovery session's scan() loop (below) is actively running, so connectDevice()
  // knows not to stop discovery out from under it. Cleared when scan() exits for any reason
  // (signal abort or an unrecoverable error after retries) — see the try/finally around scan()'s
  // loop body.
  let scanSessionActive = false;

  async function connectDevice(macAddress: string) {
    const adapter = await getAdapter();
    // Now that discovery only runs during an explicit discoverySession (see scan() below), this
    // module must not leave BlueZ discovery on forever just because a single connectDevice() call
    // needed it — that would silently defeat the whole point of scoping discovery. Only stop it
    // afterward if THIS call is the one that turned it on, and only if no scan() session currently
    // depends on it staying on (tracked via scanSessionActive).
    let startedDiscoveryHere = false;
    if (!(await adapter.isDiscovering())) {
      await adapter.startDiscovery().catch(() => {});
      startedDiscoveryHere = true;
    }
    try {
      const device = await withTimeout(adapter.waitDevice(macAddress, CONNECT_TIMEOUT_MS), CONNECT_TIMEOUT_MS + 2000, 'waitDevice');
      try {
        await withTimeout(device.connect(), CONNECT_TIMEOUT_MS, 'connect');
      } catch (error) {
        // Bugfix (2026-07-30, found via real production logs): `withTimeout` only stops US from
        // waiting on `device.connect()` — it does NOT cancel the underlying BlueZ Connect() D-Bus
        // call, which keeps running server-side after our client-side timeout fires. The very next
        // retry attempt (withGattRetry, 500ms later) calls connectDevice() again and issues a FRESH
        // Connect() for the same device, while BlueZ still considers the previous one in flight —
        // BlueZ immediately rejects that with org.bluez.Error.InProgress ("Operation already in
        // progress"), which isn't recognized by isGattError133 so it never triggers an adapter
        // restart either, just repeats until the original Connect() eventually resolves on its own.
        // Calling disconnect() here tells BlueZ to cancel the pending/stuck connection attempt
        // before we give up, so the next retry starts from a clean state instead of racing it.
        // device.connect() itself registers a PropertiesChanged listener before calling BlueZ's
        // Connect() (node-ble's Device.connect()) — on failure this Device is never returned to a
        // caller's try/finally, so disconnect() (the only public path that releases it) never runs
        // on its own, which is why this is also the first place doing so explicitly.
        await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect-after-failed-connect').catch(() => {});
        releaseDbusListeners(device);
        throw error;
      }
      return device;
    } finally {
      if (startedDiscoveryHere && !scanSessionActive) {
        await adapter.stopDiscovery().catch(() => {});
      }
    }
  }

  // subscribeLive (below) deliberately never retries the live-notify loop itself once
  // streaming has started (restarting a multi-minute session from scratch after it already
  // streamed real samples would be wrong) — but its one-shot initial connectDevice() call is a
  // plain connection attempt like any other, and was the one BLE operation in this file with zero
  // retry at all. Confirmed against real production logs (2026-07-30): a live session that never
  // got past connectDevice() (no "Activate live measure period (live session)" log line at all)
  // died on a single transient `le-connection-abort-by-local`, the same everyday connect hiccup
  // that readSensors/triggerAction/PlantDr calibration already recover from via withGattRetry.
  // Same retry policy here, applied to the connect step only.
  function connectDeviceWithRetry(deviceId: string, label: string) {
    return withGattRetry({
      label,
      deviceId,
      isGattError133,
      restartAdapter,
      attempt: () => connectDevice(deviceId),
    });
  }

  return {
    name: 'node-ble',

    async scan(onDiscovered, signal) {
      const adapter = await getAdapter();

      // Marks this scan() session as owning discovery for the whole loop's duration, so a
      // concurrent connectDevice() call (e.g. namedDevicePoller reading a device while this
      // discovery session is also active) never stops discovery out from under this loop in its
      // own finally block. Cleared unconditionally below regardless of how the loop exits (abort,
      // or falling through after signal.aborted becomes true).
      scanSessionActive = true;
      try {
        while (!signal.aborted) {
          // A whole scan cycle (start discovery, poll for SCAN_WINDOW_MS, stop discovery) is
          // wrapped defensively: restartAdapter() (retry.ts, triggered by a GATT_ERROR=133 during a
          // concurrent readSensors/connect elsewhere) power-cycles this exact same shared adapter
          // with no coordination with this loop, so an adapter method call landing mid-power-cycle
          // throws a transient "Resource Not Ready"/"Not Ready" D-Bus error here. That single error
          // used to propagate out of scan() and kill discovery forever (2026-07-29 incident — the
          // caller at the time never relaunched it; that caller has since been replaced by
          // backend/src/ble/discoverySession.ts). Now: log, back off briefly, and retry the cycle
          // instead of letting the whole function die on a transient condition.
          try {
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
          } catch (error) {
            log({
              direction: 'SCAN',
              label: 'Scan cycle failed (adapter likely mid-restart) — retrying shortly',
              result: 'ERROR',
              detail: error instanceof Error ? error.message : String(error),
            });
            if (signal.aborted) break;
            await sleep(GATT_133_BACKOFF_MS * 4);
            continue;
          }

          if (signal.aborted) break;
          await sleep(SCAN_PAUSE_MS);
        }
      } finally {
        // Cleared unconditionally (loop exit via abort, or an uncaught error escaping the inner
        // try/catch above — shouldn't happen given that catch, but this must never leave the flag
        // stuck true) so a subsequent connectDevice() call is free to stop discovery again once no
        // session depends on it.
        scanSessionActive = false;
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
              // Also timeout-wrapped (all 5 disconnect() sites in this file, 2026-07-29): an
              // un-wrapped Disconnect() D-Bus call that hangs (observed in production right after
              // an adapter restart) used to block forever — and since every GATT operation goes
              // through the single sequential connectionQueue, that one hung disconnect froze it
              // permanently, silently killing both polling AND every future manual "water" trigger.
              await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect').catch(() => {});
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

            let soilConductivityRaw: number | undefined;
            try {
              const conductivityChar = await trackedCharacteristic(sensorService, UUIDS.live.soilConductivityRaw, characteristics);
              soilConductivityRaw = readSoilConductivityRawValue(await conductivityChar.readValue());
              log({ direction: 'READ', label: 'Soil conductivity raw read', deviceId, result: 'OK', detail: `raw=${soilConductivityRaw}` });
            } catch (error) {
              log({
                direction: 'INFO',
                label: 'Soil conductivity indisponible',
                deviceId,
                result: 'ERROR',
                detail: error instanceof Error ? error.message : String(error),
              });
            }

            // Raw sensor debug log — Live-service characteristics only, so (like
            // soilConductivityRaw above) these MUST be read before the fa06=0 deactivation below:
            // the Live service doesn't refresh its values without live mode active (fa06=1,
            // ble/parrot/uuids.ts's measurePeriod comment), so reading these after deactivation
            // would silently return stale/frozen values with no error to reveal it. Every field
            // here is still best-effort, logged individually, never failing the rest of the poll
            // (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-and-raw-sensor-
            // log-design.md).
            const lightRaw = await readRawBestEffort(sensorService, UUIDS.live.lightRaw, characteristics, deviceId, 'Light raw', readU16);
            const soilTempRaw = await readRawBestEffort(
              sensorService,
              UUIDS.live.soilTempRaw,
              characteristics,
              deviceId,
              'Soil temp raw',
              readU16,
            );
            const airTempRaw = await readRawBestEffort(
              sensorService,
              UUIDS.live.airTempRaw,
              characteristics,
              deviceId,
              'Air temp raw',
              readU16,
            );
            const soilMoistureRaw = await readRawBestEffort(
              sensorService,
              UUIDS.live.soilMoistureRaw,
              characteristics,
              deviceId,
              'Soil moisture raw',
              readU16,
            );
            const eaRaw = await readRawBestEffort(sensorService, UUIDS.live.eaCal, characteristics, deviceId, 'Ea raw', (b) =>
              b.readFloatLE(0),
            );
            const ecbRaw = await readRawBestEffort(sensorService, UUIDS.live.ecbCal, characteristics, deviceId, 'Ecb raw', (b) =>
              b.readFloatLE(0),
            );
            const ecPorousRaw = await readRawBestEffort(
              sensorService,
              UUIDS.live.ecPorousCal,
              characteristics,
              deviceId,
              'EcPorous raw',
              (b) => b.readFloatLE(0),
            );

            await measurePeriod.writeValueWithResponse(Buffer.from([0])).catch(() => {});

            // Plant Dr STATUS_FLAGS (Batch 6) — best-effort like the conductivity reads above: the
            // Plant Dr service may not exist on every firmware revision, must never fail the read.
            // Unlike the Live-service reads above, STATUS_FLAGS is on a different GATT service
            // (Plant Dr) with no measure-period gate, so reading it after deactivation is correct.
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

            let watVwcIrr: number | undefined;
            let watVwcCmd: number | undefined;
            let watNIrr: number | undefined;
            let watPumpDutyCycle: number | undefined;
            let watVwcIrrEco: number | undefined;
            let watVwcCmdEco: number | undefined;
            let watNIrrEco: number | undefined;
            let watMode: number | undefined;
            let watTimeSlotStart: number | undefined;
            let watTimeSlotDurr: number | undefined;
            let watVacationStart: number | undefined;
            let watVacationEnd: number | undefined;
            let algorithmStatus: number | undefined;
            try {
              const wateringServiceForRaw = await gatt.getPrimaryService(WATERING_SERVICE_UUID);
              watVwcIrr = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.vwcIrr,
                characteristics,
                deviceId,
                'wat_vwc_irr',
                readU16,
              );
              watVwcCmd = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.vwcCmd,
                characteristics,
                deviceId,
                'wat_vwc_cmd',
                readU16,
              );
              watNIrr = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.nIrr,
                characteristics,
                deviceId,
                'wat_n_irr',
                readU16,
              );
              watPumpDutyCycle = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.pumpDutyCycle,
                characteristics,
                deviceId,
                'wat_pump_duty_cycle',
                readU8,
              );
              watVwcIrrEco = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.vwcIrrEco,
                characteristics,
                deviceId,
                'wat_vwc_irr_eco',
                readU16,
              );
              watVwcCmdEco = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.vwcCmdEco,
                characteristics,
                deviceId,
                'wat_vwc_cmd_eco',
                readU16,
              );
              watNIrrEco = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.nIrrEco,
                characteristics,
                deviceId,
                'wat_n_irr_eco',
                readU16,
              );
              watMode = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.mode, characteristics, deviceId, 'wat_mode', readU8);
              watTimeSlotStart = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.timeSlotStart,
                characteristics,
                deviceId,
                'wat_time_slot_start',
                readU16,
              );
              watTimeSlotDurr = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.timeSlotDurr,
                characteristics,
                deviceId,
                'wat_time_slot_durr',
                readU16,
              );
              watVacationStart = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.vacationStart,
                characteristics,
                deviceId,
                'wat_vacation_start',
                readU32,
              );
              watVacationEnd = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.vacationEnd,
                characteristics,
                deviceId,
                'wat_vacation_end',
                readU32,
              );
              algorithmStatus = await readRawBestEffort(
                wateringServiceForRaw,
                UUIDS.watering.algorithmStatus,
                characteristics,
                deviceId,
                'algorithm_status',
                readU8,
              );
            } catch (error) {
              log({
                direction: 'INFO',
                label: 'Watering config service indisponible',
                deviceId,
                result: 'ERROR',
                detail: error instanceof Error ? error.message : String(error),
              });
            }

            let plantDrStatusFlagsRaw: number | undefined;
            let plantDrDryN: number | undefined;
            let plantDrDryVwcRaw: number | undefined;
            let plantDrWetN: number | undefined;
            let plantDrWetVwcRaw: number | undefined;
            let plantDrConfigId: number | undefined;
            let plantDrNextWateringDate: number | undefined;
            let plantDrNextEmptyTankDate: number | undefined;
            let plantDrFullTankAutonomy: number | undefined;
            try {
              const plantDrServiceForRaw = await gatt.getPrimaryService(PLANT_DR_SERVICE_UUID);
              plantDrStatusFlagsRaw = await readRawBestEffort(
                plantDrServiceForRaw,
                UUIDS.plantDr.statusFlags,
                characteristics,
                deviceId,
                'plantDr status raw',
                readU8,
              );
              plantDrDryN = await readRawBestEffort(
                plantDrServiceForRaw,
                UUIDS.plantDr.dryN,
                characteristics,
                deviceId,
                'plantDr dryN',
                readU16,
              );
              plantDrDryVwcRaw = await readRawBestEffort(
                plantDrServiceForRaw,
                UUIDS.plantDr.dryVwc,
                characteristics,
                deviceId,
                'plantDr dryVwc',
                readU16,
              );
              plantDrWetN = await readRawBestEffort(
                plantDrServiceForRaw,
                UUIDS.plantDr.wetN,
                characteristics,
                deviceId,
                'plantDr wetN',
                readU16,
              );
              plantDrWetVwcRaw = await readRawBestEffort(
                plantDrServiceForRaw,
                UUIDS.plantDr.wetVwc,
                characteristics,
                deviceId,
                'plantDr wetVwc',
                readU16,
              );
              plantDrConfigId = await readRawBestEffort(
                plantDrServiceForRaw,
                UUIDS.plantDr.configId,
                characteristics,
                deviceId,
                'plantDr configId',
                readU16,
              );
              plantDrNextWateringDate = await readRawBestEffort(
                plantDrServiceForRaw,
                UUIDS.plantDr.nextWateringDate,
                characteristics,
                deviceId,
                'plantDr nextWateringDate',
                readU32,
              );
              plantDrNextEmptyTankDate = await readRawBestEffort(
                plantDrServiceForRaw,
                UUIDS.plantDr.nextEmptyTankDate,
                characteristics,
                deviceId,
                'plantDr nextEmptyTankDate',
                readU32,
              );
              plantDrFullTankAutonomy = await readRawBestEffort(
                plantDrServiceForRaw,
                UUIDS.plantDr.fullTankAutonomy,
                characteristics,
                deviceId,
                'plantDr fullTankAutonomy',
                readU32,
              );
            } catch (error) {
              log({
                direction: 'INFO',
                label: 'Plant Dr extra fields indisponibles',
                deviceId,
                result: 'ERROR',
                detail: error instanceof Error ? error.message : String(error),
              });
            }

            let calibrationDataBlobHex: string | undefined;
            let colorRaw: number | undefined;
            try {
              const calibrationService = await gatt.getPrimaryService(CALIBRATION_SERVICE_UUID);
              calibrationDataBlobHex = await readRawBestEffort(
                calibrationService,
                UUIDS.calibration.dataBlob,
                characteristics,
                deviceId,
                'calibration blob',
                (b) => b.toString('hex'),
              );
              colorRaw = await readRawBestEffort(
                calibrationService,
                UUIDS.calibration.color,
                characteristics,
                deviceId,
                'color raw',
                readU16,
              );
            } catch (error) {
              log({
                direction: 'INFO',
                label: 'Calibration service indisponible',
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
                isDrySoil: statusFlags?.isDrySoil,
                isWetSoil: statusFlags?.isWetSoil,
                isEmptyTank: statusFlags?.isEmptyTank,
                isInAir: statusFlags?.isInAir,
                lightRaw,
                soilConductivityRaw,
                soilTempRaw,
                airTempRaw,
                soilMoistureRaw,
                eaRaw,
                ecbRaw,
                ecPorousRaw,
                watVwcIrr,
                watVwcCmd,
                watNIrr,
                watPumpDutyCycle,
                watVwcIrrEco,
                watVwcCmdEco,
                watNIrrEco,
                watMode,
                watTimeSlotStart,
                watTimeSlotDurr,
                watVacationStart,
                watVacationEnd,
                algorithmStatus,
                plantDrStatusFlagsRaw,
                plantDrDryN,
                plantDrDryVwcRaw,
                plantDrWetN,
                plantDrWetVwcRaw,
                plantDrConfigId,
                plantDrNextWateringDate,
                plantDrNextEmptyTankDate,
                plantDrFullTankAutonomy,
                calibrationDataBlobHex,
                colorRaw,
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
            await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect').catch(() => {});
            releaseDbusListeners(device);
          }
        },
      });
    },

    // Deliberately does NOT wrap the whole session in withGattRetry like readSensors does — that
    // helper's retry semantics assume a quick one-shot operation; retrying a multi-minute live
    // session from scratch after it already streamed real samples would be wrong. Only the
    // initial connection (via connectDeviceWithRetry, see connectDevice's own comment above) gets
    // the standard 3-attempt/backoff/adapter-restart retry policy — a mid-session disconnect after
    // that still ends the function outright, with no retry.
    async subscribeLive(deviceId: string, kind, onSample, signal): Promise<void> {
      // A signal that's already aborted before this method is even called must return
      // immediately — an `addEventListener('abort', ...)` added afterward never fires for an
      // event that already happened (AbortSignal semantics), which would otherwise hang forever
      // (found during Task 3's review on the mock provider — the same class of bug applies here).
      if (signal.aborted) return;

      // Re-checked after every setup await below (connectDevice/gatt()/getPrimaryService/
      // getCharacteristic/startNotifications), not just once at function entry: `signal.aborted`
      // is a plain, synchronously-updated boolean, so it correctly reflects an abort that fired
      // while one of those awaits was in flight — no event listener is needed for this, only for
      // reacting to an abort *during* the live-notify loop below, which otherwise has nothing else
      // to wait on. Skipping this re-check was a real bug: connectDevice() alone can block for
      // ~20s (adapter.waitDevice()'s own timeout) waiting for the device's next BLE advertisement,
      // and an abort landing in that window used to be lost — the live-loop Promise (the only place
      // that registered an abort listener) never got created to observe it, so subscribeLive never
      // returned, its `finally` blocks never ran `device.disconnect()`, and since
      // connectionQueue serializes to a single shared GATT connection, that alone could
      // permanently starve every other Parrot/Xiaomi operation in the app.
      if (kind === 'XIAOMI_LYWSD03MMC') {
        const device = await connectDeviceWithRetry(deviceId, 'subscribeLive:xiaomi');
        try {
          if (signal.aborted) return;

          const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
          const dataService = await gatt.getPrimaryService(XIAOMI_DATA_SERVICE_UUID);
          const tempHumidityChar = await dataService.getCharacteristic(TEMP_HUMIDITY_CHARACTERISTIC_UUID);
          try {
            if (signal.aborted) return;

            await tempHumidityChar.startNotifications();
            try {
              if (signal.aborted) return;

              await new Promise<void>((resolve, reject) => {
                let pending: Promise<void> = Promise.resolve();
                const onValue = (buf: Buffer) => {
                  const data = parseTempHumidityPayload(buf);
                  // Serialized (never overlapping, via the `pending` chain) AND
                  // error-propagating: an onSample failure (e.g. a transient DB write error while
                  // persisting a live sample) must end the session as a thrown error, never become
                  // an orphaned unhandled promise rejection — matches the mock provider's
                  // equivalent fix (commit f075828, "Fix subscribeLive: handle pre-aborted signals
                  // and serialize onSample calls").
                  pending = pending
                    .then(() => onSample({ kind: 'XIAOMI_LYWSD03MMC', data }))
                    .catch((error) => {
                      cleanupListeners();
                      reject(error);
                    });
                };
                const cleanupListeners = () => {
                  tempHumidityChar.removeListener('valuechanged', onValue);
                  signal.removeEventListener('abort', onAbort);
                  device.removeListener('disconnect', onDisconnect);
                };
                const onAbort = () => {
                  cleanupListeners();
                  // Let the last in-flight onSample settle before resolving — never let the
                  // disconnect() below fire while a persist might still be running (this project's
                  // never-fire-and-forget convention, spec 7.1). `pending` itself never rejects
                  // (the .catch above always intercepts and settles the outer promise via reject
                  // instead), so this can't hang and won't throw here.
                  void pending.then(resolve);
                };
                const onDisconnect = () => {
                  cleanupListeners();
                  void pending.then(() => reject(new Error('Device disconnected unexpectedly during live session')));
                };
                tempHumidityChar.on('valuechanged', onValue);
                signal.addEventListener('abort', onAbort, { once: true });
                device.once('disconnect', onDisconnect);
              });
            } finally {
              await tempHumidityChar.stopNotifications().catch(() => {});
            }
          } finally {
            releaseDbusListeners(tempHumidityChar);
          }
        } finally {
          await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect').catch(() => {});
          releaseDbusListeners(device);
        }
        return;
      }

      const device = await connectDeviceWithRetry(deviceId, 'subscribeLive');
      const characteristics: GattCharacteristic[] = [];
      try {
        if (signal.aborted) return;

        const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
        const sensorService = await gatt.getPrimaryService(SENSOR_SERVICE_UUID);
        if (signal.aborted) return;

        const measurePeriod = await trackedCharacteristic(sensorService, UUIDS.live.measurePeriod, characteristics);
        await measurePeriod.writeValueWithResponse(Buffer.from([1]));
        log({
          direction: 'WRITE',
          label: 'Activate live measure period (live session)',
          uuid: UUIDS.live.measurePeriod,
          deviceId,
          payloadHex: '01',
          result: 'OK',
        });

        try {
          if (signal.aborted) return;

          const soilChar = await trackedCharacteristic(sensorService, UUIDS.live.soilMoisturePercent, characteristics);
          const tempChar = await trackedCharacteristic(sensorService, UUIDS.live.temperatureC, characteristics);
          const luxChar = await trackedCharacteristic(sensorService, UUIDS.live.luminosity, characteristics);
          if (signal.aborted) return;

          await soilChar.startNotifications();
          await tempChar.startNotifications();
          await luxChar.startNotifications();

          try {
            if (signal.aborted) return;

            await new Promise<void>((resolve, reject) => {
              const pending: { soilMoisturePercent?: number; temperatureC?: number; luminosity?: number } = {};
              let flushTimer: NodeJS.Timeout | undefined;
              let flushing: Promise<void> = Promise.resolve();

              const scheduleFlush = () => {
                if (flushTimer) return;
                flushTimer = setTimeout(() => {
                  flushTimer = undefined;
                  if (pending.soilMoisturePercent === undefined || pending.temperatureC === undefined || pending.luminosity === undefined) {
                    return; // wait for the first complete triple before ever sampling
                  }
                  const snapshot = {
                    soilMoisturePercent: pending.soilMoisturePercent,
                    temperatureC: pending.temperatureC,
                    luminosity: pending.luminosity,
                  };
                  // Error-propagating, matching the Xiaomi branch above and the mock provider's
                  // fix (commit f075828): an onSample failure must end the session as a thrown
                  // error, never an orphaned unhandled rejection.
                  flushing = flushing
                    .then(() => onSample({ kind: 'PARROT_POT', data: snapshot }))
                    .catch((error) => {
                      cleanupListeners();
                      reject(error);
                    });
                }, LIVE_SAMPLE_DEBOUNCE_MS);
              };

              const onSoil = (buf: Buffer) => {
                pending.soilMoisturePercent = buf.readFloatLE(0);
                scheduleFlush();
              };
              const onTemp = (buf: Buffer) => {
                pending.temperatureC = buf.readFloatLE(0);
                scheduleFlush();
              };
              const onLux = (buf: Buffer) => {
                pending.luminosity = buf.readFloatLE(0);
                scheduleFlush();
              };

              const cleanupListeners = () => {
                soilChar.removeListener('valuechanged', onSoil);
                tempChar.removeListener('valuechanged', onTemp);
                luxChar.removeListener('valuechanged', onLux);
                if (flushTimer) clearTimeout(flushTimer);
                signal.removeEventListener('abort', onAbort);
                device.removeListener('disconnect', onDisconnect);
              };
              const onAbort = () => {
                cleanupListeners();
                // Let the last in-flight onSample settle before resolving — same
                // never-fire-and-forget reasoning as the Xiaomi branch above. `flushing` itself
                // never rejects (the .catch above always intercepts and settles the outer promise
                // via reject instead), so this can't hang and won't throw here.
                void flushing.then(resolve);
              };
              const onDisconnect = () => {
                cleanupListeners();
                void flushing.then(() => reject(new Error('Device disconnected unexpectedly during live session')));
              };

              soilChar.on('valuechanged', onSoil);
              tempChar.on('valuechanged', onTemp);
              luxChar.on('valuechanged', onLux);
              signal.addEventListener('abort', onAbort, { once: true });
              device.once('disconnect', onDisconnect);
            });
          } finally {
            for (const characteristic of [soilChar, tempChar, luxChar]) {
              await characteristic.stopNotifications().catch(() => {});
            }
          }
        } finally {
          await measurePeriod.writeValueWithResponse(Buffer.from([0])).catch(() => {});
        }
      } finally {
        for (const characteristic of characteristics) releaseDbusListeners(characteristic);
        await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect').catch(() => {});
        releaseDbusListeners(device);
      }
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
            await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect').catch(() => {});
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
            await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect').catch(() => {});
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
            await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect').catch(() => {});
            releaseDbusListeners(device);
          }
        },
      });
    },
  };
}
