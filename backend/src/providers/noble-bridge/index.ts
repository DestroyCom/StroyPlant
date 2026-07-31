import type { PlantDrCalibration, PlantDrWriteValues } from '../../ble/parrot/plantDr.js';
import { env } from '../../env.js';
import { log } from '../../logger.js';
import type { DeviceKind, DeviceProvider, DiscoveredDevice, SensorReading } from '../types.js';

// Provider that delegates all the real BLE work to the noble-bridge process (native macOS, outside
// Docker, see noble-bridge/). This provider is just an HTTP/WebSocket client — see
// docs/STROYPLANT_SPEC.md section 6. Device ids here are "logical" ids (PARROT-XXXX / XIAOMI-<noble
// uuid>, not the real MAC — CoreBluetooth doesn't expose it): they do NOT match the MAC ids used by
// the node-ble provider in prod. Expected — this provider is meant to validate the protocol, not
// data continuity across environments.

export function createNobleBridgeProvider(): DeviceProvider {
  return {
    name: 'noble-bridge',

    async scan(onDiscovered, signal) {
      const wsUrl = `${env.nobleBridgeUrl.replace(/^http/, 'ws')}/scan-stream`;
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(wsUrl);

        socket.addEventListener('open', () => {
          log({ direction: 'SCAN', label: `Connected to noble-bridge (${wsUrl})`, result: 'OK' });
        });

        socket.addEventListener('message', (event) => {
          try {
            const { id, kind, name, rssi, advertisementPayloadHex } = JSON.parse(event.data as string) as {
              id: string;
              kind: DeviceKind;
              name: string;
              rssi: number;
              advertisementPayloadHex?: string;
            };
            const device: DiscoveredDevice = { id, kind, name, rssi, advertisementPayloadHex };
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
              `Connection to noble-bridge failed (${wsUrl}) — is the noble-bridge process running? (pnpm --filter noble-bridge dev)`,
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
          data: {
            temperatureC: body.temperatureC,
            humidityPercent: body.humidityPercent,
            batteryPercent: body.batteryPercent,
            tempRaw: body.tempRaw,
            humidityRaw: body.humidityRaw,
            voltageRawMv: body.voltageRawMv,
          },
        };
      }
      return {
        kind: 'PARROT_POT',
        data: {
          soilMoisturePercent: body.soilMoisturePercent,
          temperatureC: body.temperatureC,
          luminosity: body.luminosity,
          waterTankLevelPercent: body.waterTankLevelPercent,
          soilConductivityRaw: body.soilConductivityRaw,
          lightRaw: body.lightRaw,
          soilTempRaw: body.soilTempRaw,
          airTempRaw: body.airTempRaw,
          soilMoistureRaw: body.soilMoistureRaw,
          isDrySoil: body.isDrySoil,
          isWetSoil: body.isWetSoil,
          isEmptyTank: body.isEmptyTank,
          isInAir: body.isInAir,
        },
      };
    },

    async triggerAction(deviceId: string, action): Promise<void> {
      if (action !== 'water') throw new Error(`Unsupported action: ${action}`);
      const res = await fetch(`${env.nobleBridgeUrl}/devices/${encodeURIComponent(deviceId)}/water`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(`noble-bridge triggerAction ${deviceId}: ${body.error ?? res.statusText}`);
    },

    async readPlantDrCalibration(deviceId: string): Promise<PlantDrCalibration> {
      const res = await fetch(`${env.nobleBridgeUrl}/devices/${encodeURIComponent(deviceId)}/plant-dr-calibration`);
      const body = await res.json();
      if (!res.ok) throw new Error(`noble-bridge readPlantDrCalibration ${deviceId}: ${body.error ?? res.statusText}`);
      return body;
    },

    async writePlantDrCalibration(deviceId: string, values: PlantDrWriteValues): Promise<void> {
      const res = await fetch(`${env.nobleBridgeUrl}/devices/${encodeURIComponent(deviceId)}/plant-dr-calibration`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`noble-bridge writePlantDrCalibration ${deviceId}: ${body.error ?? res.statusText}`);
    },

    async subscribeLive(): Promise<void> {
      // Deliberate scope cut (docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md):
      // noble-bridge (Mac dev environment) doesn't implement real live sampling yet — validating
      // node-ble's live GATT notify happens directly on the production server, matching how
      // node-ble itself was originally validated there rather than via this provider.
      throw new Error('subscribeLive not implemented on noble-bridge');
    },
  };
}
