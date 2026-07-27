import { env } from '../../env.js';
import { log } from '../../logger.js';
import type { DeviceKind, DeviceProvider, DiscoveredDevice, SensorReading } from '../types.js';

// Provider qui délègue tout le travail BLE réel au process noble-bridge (natif macOS, hors Docker,
// voir noble-bridge/). Ce provider n'est qu'un client HTTP/WebSocket — voir docs/STROYPLANT_SPEC.md
// section 6. Les identifiants de device ici sont des ids "logiques" (PARROT-XXXX / XIAOMI-<uuid noble>,
// pas la MAC réelle — CoreBluetooth ne l'expose pas) : ne correspondent PAS aux ids MAC utilisés par
// le provider node-ble en prod. Attendu — ce provider sert à valider le protocole, pas la continuité
// des données entre environnements.

export function createNobleBridgeProvider(): DeviceProvider {
  return {
    name: 'noble-bridge',

    async scan(onDiscovered, signal) {
      const wsUrl = `${env.nobleBridgeUrl.replace(/^http/, 'ws')}/scan-stream`;
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(wsUrl);

        socket.addEventListener('open', () => {
          log({ direction: 'SCAN', label: `Connecté au noble-bridge (${wsUrl})`, result: 'OK' });
        });

        socket.addEventListener('message', (event) => {
          try {
            const { id, kind, name, rssi } = JSON.parse(event.data as string) as {
              id: string;
              kind: DeviceKind;
              name: string;
              rssi: number;
            };
            const device: DiscoveredDevice = { id, kind, name, rssi };
            onDiscovered(device);
          } catch (error) {
            log({
              direction: 'SCAN',
              label: 'Message scan-stream illisible',
              result: 'ERROR',
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        });

        socket.addEventListener('error', () => {
          reject(
            new Error(
              `Connexion au noble-bridge échouée (${wsUrl}) — le process noble-bridge tourne-t-il ? (pnpm --filter noble-bridge dev)`,
            ),
          );
        });

        socket.addEventListener('close', () => resolve());

        signal.addEventListener('abort', () => socket.close(), { once: true });
      });
    },

    async readSensors(deviceId: string, kind: DeviceKind): Promise<SensorReading> {
      const res = await fetch(`${env.nobleBridgeUrl}/devices/${encodeURIComponent(deviceId)}/sensors`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(`noble-bridge readSensors ${deviceId}: ${body.error ?? res.statusText}`);

      if (kind === 'XIAOMI_LYWSD03MMC') {
        return {
          kind: 'XIAOMI_LYWSD03MMC',
          data: { temperatureC: body.temperatureC, humidityPercent: body.humidityPercent, batteryPercent: body.batteryPercent },
        };
      }
      return {
        kind: 'PARROT_POT',
        data: {
          soilMoisturePercent: body.soilMoisturePercent,
          temperatureC: body.temperatureC,
          luminosity: body.luminosity,
          waterTankLevelPercent: body.waterTankLevelPercent,
        },
      };
    },

    async triggerAction(deviceId: string, action): Promise<void> {
      if (action !== 'water') throw new Error(`Action non supportée: ${action}`);
      const res = await fetch(`${env.nobleBridgeUrl}/devices/${encodeURIComponent(deviceId)}/water`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(`noble-bridge triggerAction ${deviceId}: ${body.error ?? res.statusText}`);
    },
  };
}
