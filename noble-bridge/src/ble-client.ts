import type { Characteristic, Peripheral } from '@abandonware/noble';
import noble from '@abandonware/noble';
import { log } from './logger.js';
import { LYWSD03MMC_NAME, PARROT_POT_NAME_PREFIX } from './uuids.js';

export type DeviceKind = 'PARROT_POT' | 'XIAOMI_LYWSD03MMC';

// Adapté de parrot-pot-debug/src/ble-client.ts (PoC déjà validé sur device réel) — voir
// STROYPLANT_SPEC.md section 6 & 9. Repris quasiment à l'identique : mêmes constantes de retry,
// même limite documentée (CoreBluetooth avale le vrai code GATT, impossible de distinguer un 133
// d'un autre échec — voir commentaire sur withConnectRetry plus bas).

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
        reject(new Error(`Bluetooth adapter state: ${state}. Vérifier que le Bluetooth du Mac est activé.`));
      }
    };
    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error(`Adapter n'a pas atteint poweredOn après ${timeoutMs}ms (état: ${noble._state}).`));
    }, timeoutMs);
    noble.on('stateChange', onStateChange);
  });
}

// L'adresse MAC réelle n'est PAS accessible via @abandonware/noble sur macOS (CoreBluetooth la
// masque pour des raisons de vie privée — `peripheral.uuid` est un identifiant interne macOS, pas
// la MAC). Pour le Parrot Pot, le nom annoncé ("Parrot pot XXXX") encode les 4 derniers hex de sa
// MAC réelle en suffixe — utilisé comme id logique lisible. Le Xiaomi LYWSD03MMC n'a pas ce suffixe
// (nom fixe "LYWSD03MMC" pour tous les devices du modèle) — on retombe sur `peripheral.uuid`
// (stable pour un device donné sur ce Mac, pas la MAC). Dans les deux cas : ne correspond PAS à
// l'id "MAC complète" utilisé par le provider node-ble en prod — attendu et documenté (section 6 de
// la spec : noble-bridge valide le protocole, pas l'identité cross-provider).
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
    label: target ? `Device trouvé: ${logicalId}` : `Device ${logicalId} non trouvé après ${timeoutMs}ms`,
    deviceId: logicalId,
    result: target ? 'OK' : 'ERROR',
  });
  return target;
}

export async function scanContinuous(
  onDiscovered: (id: string, kind: DeviceKind, name: string, rssi: number) => void,
  signal: AbortSignal,
): Promise<void> {
  await waitForPoweredOn();
  const onDiscover = (peripheral: Peripheral) => {
    const identified = identifyDevice(peripheral);
    if (identified) onDiscovered(identified.id, identified.kind, peripheral.advertisement.localName ?? '', peripheral.rssi);
  };
  noble.on('discover', onDiscover);
  await noble.startScanningAsync([], true); // allowDuplicates=true pour des mises à jour RSSI continues

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

// Détection GATT 133 impossible sur macOS/noble (CoreBluetooth avale le NSError réel, voir
// STROYPLANT_SPEC.md section 7.1 "Nuance importante"). On applique donc la logique 133 (backoff
// 500ms, avertissement au 2e échec) à TOUT échec de connexion — pas de redémarrage automatique de
// l'adaptateur Bluetooth du Mac (couperait tout le Bluetooth du système, décision utilisateur).
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
          label: `2e échec GATT consécutif (équivalent probable GATT_ERROR=133) — tentative ${i}/${CONNECT_RETRY_ATTEMPTS}`,
          deviceId: logicalId,
          result: 'ERROR',
          detail: `${detail} — redémarrage manuel du Bluetooth du Mac recommandé si ça persiste`,
        });
      } else {
        log({
          direction: 'CONNECT',
          label: `Échec de connexion, tentative ${i}/${CONNECT_RETRY_ATTEMPTS}`,
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
      detail: `${characteristics.length} caractéristique(s)`,
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

// Le LYWSD03MMC ne se lit pas par un simple readAsync() — il faut souscrire aux notifications et
// attendre la première valeur (validé empiriquement sur device réel, voir uuids.ts).
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

// Scan-puis-connecte, générique pour tout device identifié par identifyDevice() (Parrot Pot ou
// Xiaomi) — factorisé ici pour être réutilisé par parrot.ts et xiaomi.ts.
export async function withDevice<T>(logicalId: string, work: (device: ConnectedDevice) => Promise<T>): Promise<T> {
  const peripheral = await scanForDevice(logicalId);
  if (!peripheral) throw new Error(`Device ${logicalId} non trouvé au scan`);
  const connected = await connectAndDiscover(peripheral, logicalId);
  try {
    return await work(connected);
  } finally {
    await disconnect(peripheral, logicalId).catch(() => {});
  }
}
