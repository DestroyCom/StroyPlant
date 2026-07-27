import { log } from '../../logger.js';
import type { DeviceProvider, DiscoveredDevice, SensorReading } from '../types.js';

// Simule des scénarios utiles, pas juste du bruit aléatoire plat (STROYPLANT_SPEC.md section 6) :
// - MOCK-POT-NORMAL : pot sain, réservoir plein, humidité stable — cas nominal.
// - MOCK-POT-DECLINE : humidité qui descend progressivement (pour tester une alerte de santé plus
//   tard) ET réservoir vide dès le départ (pour tester la gestion d'erreur d'un arrosage qui échoue
//   — le scénario réaliste où le pot qui a le plus besoin d'eau ne peut justement plus en donner).

interface MockPotState {
  id: string;
  name: string;
  soilMoisturePercent: number;
  temperatureC: number;
  luminosity: number;
  waterTankLevelPercent: number;
  declinePerMinute: number;
  lastUpdate: number;
}

function createInitialState(): MockPotState[] {
  const now = Date.now();
  return [
    {
      id: 'MOCK-POT-NORMAL',
      name: 'Parrot pot mock1',
      soilMoisturePercent: 38,
      temperatureC: 21,
      luminosity: 450,
      waterTankLevelPercent: 90,
      declinePerMinute: 0.05,
      lastUpdate: now,
    },
    {
      id: 'MOCK-POT-DECLINE',
      name: 'Parrot pot mock2',
      soilMoisturePercent: 32,
      temperatureC: 22,
      luminosity: 300,
      waterTankLevelPercent: 0, // réservoir vide dès le départ — tout triggerAction('water') doit échouer
      declinePerMinute: 1.2, // descend nettement plus vite que MOCK-POT-NORMAL
      lastUpdate: now,
    },
  ];
}

function applyDecay(state: MockPotState): void {
  const elapsedMinutes = (Date.now() - state.lastUpdate) / 60_000;
  if (elapsedMinutes <= 0) return;
  state.soilMoisturePercent = Math.max(0, state.soilMoisturePercent - state.declinePerMinute * elapsedMinutes);
  state.temperatureC += (Math.random() - 0.5) * 0.3;
  state.luminosity = Math.max(0, state.luminosity + (Math.random() - 0.5) * 20);
  state.lastUpdate = Date.now();
}

export function createMockProvider(): DeviceProvider {
  const pots = new Map(createInitialState().map((p) => [p.id, p]));

  return {
    name: 'mock',

    async scan(onDiscovered, signal) {
      const emitAll = () => {
        for (const pot of pots.values()) {
          const device: DiscoveredDevice = { id: pot.id, kind: 'PARROT_POT', name: pot.name, rssi: -50 };
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

    async readSensors(deviceId: string): Promise<SensorReading> {
      const pot = pots.get(deviceId);
      if (!pot) throw new Error(`Mock device ${deviceId} inconnu`);
      applyDecay(pot);
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
        },
      };
    },

    async triggerAction(deviceId: string, action): Promise<void> {
      if (action !== 'water') throw new Error(`Action non supportée: ${action}`);
      const pot = pots.get(deviceId);
      if (!pot) throw new Error(`Mock device ${deviceId} inconnu`);
      applyDecay(pot);

      if (pot.waterTankLevelPercent <= 0) {
        log({
          direction: 'WRITE',
          label: 'Watering trigger (mock)',
          deviceId,
          result: 'ERROR',
          detail: 'Réservoir vide — arrosage impossible',
        });
        throw new Error('Réservoir vide — arrosage impossible');
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
