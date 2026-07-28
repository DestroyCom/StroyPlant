import { log } from '../../logger.js';
import type { DeviceProvider, DiscoveredDevice, SensorReading } from '../types.js';

// Simulates useful scenarios, not just flat random noise (docs/STROYPLANT_SPEC.md section 6):
// - MOCK-POT-NORMAL: healthy pot, full reservoir, stable moisture — nominal case.
// - MOCK-POT-DECLINE: moisture progressively dropping (to test a health alert later) AND an
//   empty reservoir from the start (to test error handling for a watering that fails
//   — the realistic scenario where the pot that most needs water precisely can't be given any).
// - MOCK-XIAOMI-01: stable ambient sensor (temperature/humidity), same GATT connection model
//   as the Parrot Pot (see spec section 3 correction) — no triggerable action on it.

interface MockPotState {
  id: string;
  name: string;
  soilMoisturePercent: number;
  temperatureC: number;
  luminosity: number;
  waterTankLevelPercent: number;
  soilConductivityEcb: number;
  soilConductivityEcPorous: number;
  declinePerMinute: number;
  lastUpdate: number;
}

interface MockXiaomiState {
  id: string;
  name: string;
  temperatureC: number;
  humidityPercent: number;
  batteryPercent: number;
  lastUpdate: number;
}

function createInitialPots(): MockPotState[] {
  const now = Date.now();
  return [
    {
      id: 'MOCK-POT-NORMAL',
      name: 'Parrot pot mock1',
      soilMoisturePercent: 38,
      temperatureC: 21,
      luminosity: 450,
      waterTankLevelPercent: 90,
      // Synthetic values (no real data collected) — Ec porous > Ecb, consistent with the
      // derivation that removes the soil/air diluting effect (docs/HEALTH_ENGINE.md), used for
      // scoring. Magnitude aligned with the typical "Soil conductivity" CSV range (hundreds-thousands
      // µS/cm), to be corrected if real values observed on a real device turn out different.
      soilConductivityEcb: 600,
      soilConductivityEcPorous: 900,
      declinePerMinute: 0.05,
      lastUpdate: now,
    },
    {
      id: 'MOCK-POT-DECLINE',
      name: 'Parrot pot mock2',
      soilMoisturePercent: 32,
      temperatureC: 22,
      luminosity: 300,
      waterTankLevelPercent: 0, // empty reservoir from the start — any triggerAction('water') must fail
      soilConductivityEcb: 550,
      soilConductivityEcPorous: 850,
      declinePerMinute: 1.2, // drops noticeably faster than MOCK-POT-NORMAL
      lastUpdate: now,
    },
  ];
}

function createInitialXiaomi(): MockXiaomiState[] {
  return [
    { id: 'MOCK-XIAOMI-01', name: 'LYWSD03MMC', temperatureC: 21.5, humidityPercent: 48, batteryPercent: 85, lastUpdate: Date.now() },
  ];
}

function applyPotDecay(state: MockPotState): void {
  const elapsedMinutes = (Date.now() - state.lastUpdate) / 60_000;
  if (elapsedMinutes <= 0) return;
  state.soilMoisturePercent = Math.max(0, state.soilMoisturePercent - state.declinePerMinute * elapsedMinutes);
  state.temperatureC += (Math.random() - 0.5) * 0.3;
  state.luminosity = Math.max(0, state.luminosity + (Math.random() - 0.5) * 20);
  state.soilConductivityEcb = Math.max(0, state.soilConductivityEcb + (Math.random() - 0.5) * 10);
  state.soilConductivityEcPorous = Math.max(0, state.soilConductivityEcPorous + (Math.random() - 0.5) * 15);
  state.lastUpdate = Date.now();
}

function applyXiaomiNoise(state: MockXiaomiState): void {
  state.temperatureC += (Math.random() - 0.5) * 0.2;
  state.humidityPercent = Math.min(100, Math.max(0, state.humidityPercent + (Math.random() - 0.5) * 1.5));
  state.lastUpdate = Date.now();
}

export function createMockProvider(): DeviceProvider {
  const pots = new Map(createInitialPots().map((p) => [p.id, p]));
  const xiaomiSensors = new Map(createInitialXiaomi().map((x) => [x.id, x]));

  return {
    name: 'mock',

    async scan(onDiscovered, signal) {
      const emitAll = () => {
        for (const pot of pots.values()) {
          const device: DiscoveredDevice = { id: pot.id, kind: 'PARROT_POT', name: pot.name, rssi: -50 };
          onDiscovered(device);
        }
        for (const sensor of xiaomiSensors.values()) {
          const device: DiscoveredDevice = { id: sensor.id, kind: 'XIAOMI_LYWSD03MMC', name: sensor.name, rssi: -60 };
          onDiscovered(device);
        }
      };
      emitAll();
      await new Promise<void>((resolve) => {
        const interval = setInterval(emitAll, 10_000);
        signal.addEventListener(
          'abort',
          () => {
            clearInterval(interval);
            resolve();
          },
          { once: true },
        );
      });
    },

    async readSensors(deviceId: string, kind): Promise<SensorReading> {
      if (kind === 'XIAOMI_LYWSD03MMC') {
        const sensor = xiaomiSensors.get(deviceId);
        if (!sensor) throw new Error(`Mock device ${deviceId} inconnu`);
        applyXiaomiNoise(sensor);
        log({
          direction: 'READ',
          label: 'Mock Xiaomi read',
          deviceId,
          result: 'OK',
          detail: `temp=${sensor.temperatureC.toFixed(1)}°C humidity=${sensor.humidityPercent.toFixed(0)}%`,
        });
        return {
          kind: 'XIAOMI_LYWSD03MMC',
          data: { temperatureC: sensor.temperatureC, humidityPercent: sensor.humidityPercent, batteryPercent: sensor.batteryPercent },
        };
      }

      const pot = pots.get(deviceId);
      if (!pot) throw new Error(`Mock device ${deviceId} inconnu`);
      applyPotDecay(pot);
      log({
        direction: 'READ',
        label: 'Mock sensors read',
        deviceId,
        result: 'OK',
        detail: `soil=${pot.soilMoisturePercent.toFixed(1)}% tank=${pot.waterTankLevelPercent}%`,
      });
      return {
        kind: 'PARROT_POT',
        data: {
          soilMoisturePercent: pot.soilMoisturePercent,
          temperatureC: pot.temperatureC,
          luminosity: pot.luminosity,
          waterTankLevelPercent: pot.waterTankLevelPercent,
          soilConductivityEcb: pot.soilConductivityEcb,
          soilConductivityEcPorous: pot.soilConductivityEcPorous,
        },
      };
    },

    async triggerAction(deviceId: string, action): Promise<void> {
      if (action !== 'water') throw new Error(`Unsupported action: ${action}`);
      const pot = pots.get(deviceId);
      if (!pot) throw new Error(`Mock device ${deviceId} inconnu ou sans actionneur (Xiaomi ne s'arrose pas)`);
      applyPotDecay(pot);

      if (pot.waterTankLevelPercent <= 0) {
        log({
          direction: 'WRITE',
          label: 'Watering trigger (mock)',
          deviceId,
          result: 'ERROR',
          detail: 'Reservoir empty — watering impossible',
        });
        throw new Error('Reservoir empty — watering impossible');
      }

      pot.waterTankLevelPercent = Math.max(0, pot.waterTankLevelPercent - 15);
      pot.soilMoisturePercent = Math.min(55, pot.soilMoisturePercent + 25);
      log({
        direction: 'WRITE',
        label: 'Watering trigger (mock)',
        deviceId,
        result: 'OK',
        detail: `nouveau tank=${pot.waterTankLevelPercent}% soil=${pot.soilMoisturePercent.toFixed(1)}%`,
      });
    },
  };
}
