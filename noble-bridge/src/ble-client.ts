import type { Characteristic, Peripheral } from '@abandonware/noble';
import noble from '@abandonware/noble';
import { extractParrotManufacturerPayload } from './advertisement.js';
import { log } from './logger.js';
import { LYWSD03MMC_NAME, PARROT_POT_NAME_PREFIX } from './uuids.js';

export type DeviceKind = 'PARROT_POT' | 'XIAOMI_LYWSD03MMC';

// Adapted from parrot-pot-debug/src/ble-client.ts (PoC already validated on a real device) — see
// docs/STROYPLANT_SPEC.md section 6 & 9. Reused almost identically: same retry constants, same
// documented limitation (CoreBluetooth swallows the real GATT code, impossible to distinguish a 133
// from another failure — see the comment on withConnectRetry further below).

function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase().replace(/-/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPoweredOn(timeoutMs = 10000): Promise<void> {
  if (noble._state === 'poweredOn') return;
  await new Promise<void>((resolve, reject) => {
    let timeoutHandle: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      noble.removeListener('stateChange', onStateChange);
    };
    const onStateChange = (state: string) => {
      if (state === 'poweredOn') {
        cleanup();
        resolve();
      } else if (state !== 'resetting' && state !== 'unknown') {
        cleanup();
        reject(new Error(`Bluetooth adapter state: ${state}. Check that the Mac's Bluetooth is turned on.`));
      }
    };
    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error(`Adapter did not reach poweredOn after ${timeoutMs}ms (state: ${noble._state}).`));
    }, timeoutMs);
    noble.on('stateChange', onStateChange);
  });
}

// The real MAC address is NOT accessible via @abandonware/noble on macOS (CoreBluetooth masks it
// for privacy reasons — `peripheral.uuid` is a macOS-internal identifier, not the MAC). For the
// Parrot Pot, the advertised name ("Parrot pot XXXX") encodes the last 4 hex digits of its real
// MAC as a suffix — used as a readable logical id. The Xiaomi LYWSD03MMC doesn't have this suffix
// (fixed name "LYWSD03MMC" for all devices of the model) — we fall back to `peripheral.uuid`
// (stable for a given device on this Mac, not the MAC). In both cases: does NOT match the "full
// MAC" id used by the node-ble provider in prod — expected and documented (spec section 6:
// noble-bridge validates the protocol, not cross-provider identity).
export function identifyDevice(peripheral: Peripheral): { id: string; kind: DeviceKind } | undefined {
  const name = peripheral.advertisement.localName ?? '';
  if (name.startsWith(PARROT_POT_NAME_PREFIX)) {
    return { id: `PARROT-${name.slice(-4).toUpperCase()}`, kind: 'PARROT_POT' };
  }
  if (name === LYWSD03MMC_NAME) {
    return { id: `XIAOMI-${peripheral.uuid}`, kind: 'XIAOMI_LYWSD03MMC' };
  }
  return undefined;
}

export async function scanForDevice(logicalId: string, timeoutMs = 10000): Promise<Peripheral | undefined> {
  await waitForPoweredOn();
  const start = Date.now();
  let target: Peripheral | undefined;

  const onDiscover = (peripheral: Peripheral) => {
    if (identifyDevice(peripheral)?.id === logicalId) target = peripheral;
  };

  noble.on('discover', onDiscover);
  await noble.startScanningAsync([], false);
  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (target || Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve();
      }
    }, 200);
  });
  await noble.stopScanningAsync();
  noble.removeListener('discover', onDiscover);

  log({
    direction: 'SCAN',
    label: target ? `Device found: ${logicalId}` : `Device ${logicalId} not found after ${timeoutMs}ms`,
    deviceId: logicalId,
    result: target ? 'OK' : 'ERROR',
  });
  return target;
}

export async function scanContinuous(
  onDiscovered: (id: string, kind: DeviceKind, name: string, rssi: number, advertisementPayloadHex?: string) => void,
  signal: AbortSignal,
): Promise<void> {
  await waitForPoweredOn();
  const onDiscover = (peripheral: Peripheral) => {
    const identified = identifyDevice(peripheral);
    if (!identified) return;
    // Diagnostic only (Parrot Pot only), raw payload not interpreted — see
    // advertisement.ts and docs/STROYPLANT_SPEC.md section 7.1.
    const payload =
      identified.kind === 'PARROT_POT' ? extractParrotManufacturerPayload(peripheral.advertisement.manufacturerData) : undefined;
    const advertisementPayloadHex = payload?.toString('hex');
    if (advertisementPayloadHex) {
      log({
        direction: 'SCAN',
        label: 'Parrot advertisement manufacturer data (diagnostic, not interpreted)',
        deviceId: identified.id,
        result: 'OK',
        detail: advertisementPayloadHex,
      });
    }
    onDiscovered(identified.id, identified.kind, peripheral.advertisement.localName ?? '', peripheral.rssi, advertisementPayloadHex);
  };
  noble.on('discover', onDiscover);
  await noble.startScanningAsync([], true); // allowDuplicates=true for continuous RSSI updates

  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

  await noble.stopScanningAsync();
  noble.removeListener('discover', onDiscover);
}

export interface ConnectedDevice {
  peripheral: Peripheral;
  connectedAt: number;
  characteristics: Map<string, Characteristic>;
}

const CONNECT_RETRY_ATTEMPTS = 3;
const CONNECT_RETRY_PAUSE_MS = 500;

// GATT 133 detection impossible on macOS/noble (CoreBluetooth swallows the real NSError, see
// docs/STROYPLANT_SPEC.md section 7.1 "Important nuance"). We therefore apply the 133 logic
// (500ms backoff, warning on 2nd failure) to ANY connection failure — no automatic restart of the
// Mac's Bluetooth adapter (would cut off the whole system's Bluetooth, user decision).
async function withConnectRetry(logicalId: string, attempt: () => Promise<ConnectedDevice>): Promise<ConnectedDevice> {
  let lastError: unknown;
  for (let i = 1; i <= CONNECT_RETRY_ATTEMPTS; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const detail = error instanceof Error ? error.message : String(error);
      if (i >= 2) {
        log({
          direction: 'CONNECT',
          label: `2nd consecutive GATT failure (probable GATT_ERROR=133 equivalent) — attempt ${i}/${CONNECT_RETRY_ATTEMPTS}`,
          deviceId: logicalId,
          result: 'ERROR',
          detail: `${detail} — manual restart of the Mac's Bluetooth recommended if this persists`,
        });
      } else {
        log({
          direction: 'CONNECT',
          label: `Connection failure, attempt ${i}/${CONNECT_RETRY_ATTEMPTS}`,
          deviceId: logicalId,
          result: 'ERROR',
          detail,
        });
      }
      if (i < CONNECT_RETRY_ATTEMPTS) await sleep(CONNECT_RETRY_PAUSE_MS);
    }
  }
  throw lastError;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let handle!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

export async function connectAndDiscover(peripheral: Peripheral, logicalId: string): Promise<ConnectedDevice> {
  return withConnectRetry(logicalId, async () => {
    const start = Date.now();
    await withTimeout(peripheral.connectAsync(), 18000);
    const connectedAt = Date.now();
    log({ direction: 'CONNECT', label: 'Connected', deviceId: logicalId, durationMs: connectedAt - start, result: 'OK' });

    const { characteristics } = await withTimeout(peripheral.discoverAllServicesAndCharacteristicsAsync(), 18000);
    const byUuid = new Map<string, Characteristic>();
    for (const c of characteristics) byUuid.set(normalizeUuid(c.uuid), c);

    log({
      direction: 'CONNECT',
      label: 'Services/characteristics discovered',
      deviceId: logicalId,
      sinceConnectMs: Date.now() - connectedAt,
      result: 'OK',
      detail: `${characteristics.length} characteristic(s)`,
    });
    return { peripheral, connectedAt, characteristics: byUuid };
  });
}

export async function readCharacteristic(pot: ConnectedDevice, uuid: string, label: string, logicalId: string): Promise<Buffer> {
  const characteristic = pot.characteristics.get(normalizeUuid(uuid));
  if (!characteristic) throw new Error(`Characteristic ${uuid} not found`);
  const start = Date.now();
  try {
    const data = await characteristic.readAsync();
    log({
      direction: 'READ',
      label,
      uuid,
      deviceId: logicalId,
      payloadHex: data.toString('hex'),
      durationMs: Date.now() - start,
      sinceConnectMs: Date.now() - pot.connectedAt,
      result: 'OK',
    });
    return data;
  } catch (error) {
    log({
      direction: 'READ',
      label,
      uuid,
      deviceId: logicalId,
      durationMs: Date.now() - start,
      result: 'ERROR',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function writeCharacteristic(
  pot: ConnectedDevice,
  uuid: string,
  label: string,
  data: Buffer,
  withoutResponse: boolean,
  logicalId: string,
): Promise<void> {
  const characteristic = pot.characteristics.get(normalizeUuid(uuid));
  if (!characteristic) throw new Error(`Characteristic ${uuid} not found`);
  const start = Date.now();
  try {
    await characteristic.writeAsync(data, withoutResponse);
    log({
      direction: 'WRITE',
      label,
      uuid,
      deviceId: logicalId,
      payloadHex: data.toString('hex'),
      durationMs: Date.now() - start,
      sinceConnectMs: Date.now() - pot.connectedAt,
      result: 'OK',
    });
  } catch (error) {
    log({
      direction: 'WRITE',
      label,
      uuid,
      deviceId: logicalId,
      payloadHex: data.toString('hex'),
      durationMs: Date.now() - start,
      result: 'ERROR',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// The LYWSD03MMC can't be read with a simple readAsync() — you must subscribe to notifications and
// wait for the first value (validated empirically on a real device, see uuids.ts).
export async function subscribeAndWaitForFirstValue(
  pot: ConnectedDevice,
  uuid: string,
  label: string,
  logicalId: string,
  timeoutMs: number,
): Promise<Buffer> {
  const characteristic = pot.characteristics.get(normalizeUuid(uuid));
  if (!characteristic) throw new Error(`Characteristic ${uuid} not found`);

  await characteristic.subscribeAsync();
  try {
    return await withTimeout(
      new Promise<Buffer>((resolve) => {
        characteristic.once('data', (data: Buffer) => resolve(data));
      }),
      timeoutMs,
    );
  } catch (error) {
    log({
      direction: 'READ',
      label,
      uuid,
      deviceId: logicalId,
      result: 'ERROR',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await characteristic.unsubscribeAsync().catch(() => {});
  }
}

export async function disconnect(peripheral: Peripheral, logicalId: string): Promise<void> {
  if (peripheral.state === 'disconnected') return;
  try {
    await withTimeout(peripheral.disconnectAsync(), 5000);
    log({ direction: 'DISCONNECT', label: 'Disconnected', deviceId: logicalId, result: 'OK' });
  } catch (error) {
    log({
      direction: 'DISCONNECT',
      label: 'Disconnect failed',
      deviceId: logicalId,
      result: 'ERROR',
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Scan-then-connect, generic for any device identified by identifyDevice() (Parrot Pot or
// Xiaomi) — factored out here to be reused by parrot.ts and xiaomi.ts.
export async function withDevice<T>(logicalId: string, work: (device: ConnectedDevice) => Promise<T>): Promise<T> {
  const peripheral = await scanForDevice(logicalId);
  if (!peripheral) throw new Error(`Device ${logicalId} not found in scan`);
  const connected = await connectAndDiscover(peripheral, logicalId);
  try {
    return await work(connected);
  } finally {
    await disconnect(peripheral, logicalId).catch(() => {});
  }
}
