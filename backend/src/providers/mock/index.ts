import type { PlantDrCalibration, PlantDrWriteValues } from '../../ble/parrot/plantDr.js';
import { computeWateringConfigId, type WateringConfigRaw, type WateringConfigWriteValues } from '../../ble/parrot/wateringConfig.js';
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
  soilConductivityRaw: number;
  declinePerMinute: number;
  lastUpdate: number;
  plantDr: PlantDrCalibration;
  wateringConfig: WateringConfigRaw;
}

// Factory-default calibration observed on a real, never-manually-calibrated Parrot Pot
// (PARROT-A073, 2026-07-28, read-only capture) — DRY_N/WET_N at 0, DRY_VWC=17.5%,
// WET_VWC=22.5%, CONFIG_ID=78 (verified against computePlantDrConfigId()).
function defaultPlantDrCalibration(): PlantDrCalibration {
  return { dryN: 0, dryVwcPercent: 17.5, wetN: 0, wetVwcPercent: 22.5, configId: 78 };
}

// "Never configured" starting state — every field 0, matching what every real capture this
// project has taken shows for the fields it's never touched (f90a/f90b/f90c/f910/f911). configId
// is computed from the rest so a fresh read is already internally consistent, same as a real
// virgin device would be expected to be.
function defaultWateringConfig(): WateringConfigRaw {
  const fields = {
    plantId: 0,
    vwcIrrRaw: 0,
    vwcCmdRaw: 0,
    nIrr: 0,
    vwcIrrEcoRaw: 0,
    vwcCmdEcoRaw: 0,
    nIrrEco: 0,
    timeSlotStart: 0,
    timeSlotDuration: 0,
    vacationStart: 0,
    vacationEnd: 0,
    mode: 0,
  };
  return { ...fields, configId: computeWateringConfigId(fields), algorithmEnabled: false };
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
      // mol/m²/day (DLI) — confirmed via a real Parrot Pot capture (docs/STROYPLANT_SPEC.md
      // section 8) to be a small value (indoor readings around 0-10), not the hundreds this used
      // to be set to (leftover from before that unit was confirmed, looked like lux instead).
      luminosity: 5,
      waterTankLevelPercent: 90,
      // Raw fa02-equivalent ADC value (not a "fertility" number — that's derived at read time from
      // accumulated calibration, docs/superpowers/specs/2026-07-31-soil-conductivity-self-
      // calibration-and-raw-sensor-log-design.md). Chosen mid-range so applyPotDecay's noise below
      // naturally produces enough spread over time for a scratch-DB test to observe the calibration
      // gate flip to `calibrated`.
      soilConductivityRaw: 1700,
      declinePerMinute: 0.05,
      lastUpdate: now,
      plantDr: defaultPlantDrCalibration(),
      wateringConfig: defaultWateringConfig(),
    },
    {
      id: 'MOCK-POT-DECLINE',
      name: 'Parrot pot mock2',
      soilMoisturePercent: 32,
      temperatureC: 22,
      luminosity: 3,
      waterTankLevelPercent: 0, // empty reservoir from the start — any triggerAction('water') must fail
      soilConductivityRaw: 1600,
      declinePerMinute: 1.2, // drops noticeably faster than MOCK-POT-NORMAL
      lastUpdate: now,
      plantDr: defaultPlantDrCalibration(),
      wateringConfig: defaultWateringConfig(),
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
  state.luminosity = Math.max(0, state.luminosity + (Math.random() - 0.5) * 0.3);
  // Wider per-tick variance than the old µS/cm-scale noise (±15) — raw ADC counts are a bigger
  // number range (~0-2047), and enough spread here lets a scratch-DB test with backdated readings
  // observe MIN_CALIBRATION_RAW_RANGE being satisfied within a realistic simulated timespan.
  state.soilConductivityRaw = Math.max(0, Math.min(2047, state.soilConductivityRaw + (Math.random() - 0.5) * 60));
  state.lastUpdate = Date.now();
}

// Plant Dr STATUS_FLAGS (Batch 6) don't exist as separate mock state — derived from the same
// thresholds a real device would use internally, no isInAir scenario simulated yet.
function deriveStatusFlags(pot: MockPotState) {
  return {
    isDrySoil: pot.soilMoisturePercent < 20,
    isWetSoil: pot.soilMoisturePercent > 50,
    isEmptyTank: pot.waterTankLevelPercent <= 0,
    isInAir: false,
  };
}

function applyXiaomiNoise(state: MockXiaomiState): void {
  state.temperatureC += (Math.random() - 0.5) * 0.2;
  state.humidityPercent = Math.min(100, Math.max(0, state.humidityPercent + (Math.random() - 0.5) * 1.5));
  state.lastUpdate = Date.now();
}

const MOCK_LIVE_SAMPLE_INTERVAL_MS = 1000;

export function createMockProvider(): DeviceProvider {
  const pots = new Map(createInitialPots().map((p) => [p.id, p]));
  const xiaomiSensors = new Map(createInitialXiaomi().map((x) => [x.id, x]));

  function applyMockWatering(deviceId: string, label: string): void {
    const pot = pots.get(deviceId);
    if (!pot) throw new Error(`Mock device ${deviceId} inconnu ou sans actionneur (Xiaomi ne s'arrose pas)`);
    applyPotDecay(pot);

    if (pot.waterTankLevelPercent <= 0) {
      log({
        direction: 'WRITE',
        label,
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
      label,
      deviceId,
      result: 'OK',
      detail: `nouveau tank=${pot.waterTankLevelPercent}% soil=${pot.soilMoisturePercent.toFixed(1)}%`,
    });
  }

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
          data: {
            temperatureC: sensor.temperatureC,
            humidityPercent: sensor.humidityPercent,
            batteryPercent: sensor.batteryPercent,
            tempRaw: Math.round(sensor.temperatureC * 100),
            humidityRaw: Math.round(sensor.humidityPercent),
            voltageRawMv: 3000,
          },
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
      const statusFlags = deriveStatusFlags(pot);
      return {
        kind: 'PARROT_POT',
        data: {
          soilMoisturePercent: pot.soilMoisturePercent,
          temperatureC: pot.temperatureC,
          luminosity: pot.luminosity,
          waterTankLevelPercent: pot.waterTankLevelPercent,
          soilConductivityRaw: Math.round(pot.soilConductivityRaw),
          // Simulated values for the other raw fields — plausible but not meant to be realistic,
          // this provider exists for dev/testing, not hardware validation (docs/STROYPLANT_SPEC.md
          // section 6).
          lightRaw: 0,
          soilTempRaw: 780,
          airTempRaw: 787,
          soilMoistureRaw: Math.round(pot.soilMoisturePercent * 5),
          watVwcIrr: 175,
          watVwcCmd: 225,
          watNIrr: 0,
          watPumpDutyCycle: 70,
          watVwcIrrEco: 150,
          watVwcCmdEco: 200,
          watNIrrEco: 0,
          watMode: 1,
          watTimeSlotStart: 1200,
          watTimeSlotDurr: 360,
          algorithmStatus: 1,
          plantDrStatusFlagsRaw: (statusFlags.isDrySoil ? 1 : 0) | (statusFlags.isWetSoil ? 2 : 0) | (statusFlags.isEmptyTank ? 4 : 0),
          plantDrDryN: pot.plantDr.dryN,
          plantDrDryVwcRaw: Math.round(pot.plantDr.dryVwcPercent * 10),
          plantDrWetN: pot.plantDr.wetN,
          plantDrWetVwcRaw: Math.round(pot.plantDr.wetVwcPercent * 10),
          plantDrConfigId: pot.plantDr.configId,
          isDrySoil: statusFlags.isDrySoil,
          isWetSoil: statusFlags.isWetSoil,
          isEmptyTank: statusFlags.isEmptyTank,
          isInAir: statusFlags.isInAir,
        },
      };
    },

    async subscribeLive(deviceId: string, kind, onSample, signal, onConnectionReady): Promise<void> {
      if (kind === 'PARROT_POT' && onConnectionReady) {
        onConnectionReady({
          async triggerWatering() {
            applyMockWatering(deviceId, 'Watering trigger (mock, via live connection)');
          },
        });
      }

      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          resolve();
          return;
        }

        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        const scheduleNextTick = () => {
          if (signal.aborted) {
            resolve();
            return;
          }

          timeoutId = setTimeout(() => {
            void (async () => {
              try {
                if (kind === 'XIAOMI_LYWSD03MMC') {
                  const sensor = xiaomiSensors.get(deviceId);
                  if (!sensor) throw new Error(`Mock device ${deviceId} inconnu`);
                  applyXiaomiNoise(sensor);
                  await onSample({
                    kind: 'XIAOMI_LYWSD03MMC',
                    data: {
                      temperatureC: sensor.temperatureC,
                      humidityPercent: sensor.humidityPercent,
                      batteryPercent: sensor.batteryPercent,
                    },
                  });
                } else {
                  const pot = pots.get(deviceId);
                  if (!pot) throw new Error(`Mock device ${deviceId} inconnu`);
                  applyPotDecay(pot);
                  await onSample({
                    kind: 'PARROT_POT',
                    data: { soilMoisturePercent: pot.soilMoisturePercent, temperatureC: pot.temperatureC, luminosity: pot.luminosity },
                  });
                }

                scheduleNextTick();
              } catch (error) {
                if (timeoutId !== null) {
                  clearTimeout(timeoutId);
                }
                reject(error);
              }
            })();
          }, MOCK_LIVE_SAMPLE_INTERVAL_MS);
        };

        scheduleNextTick();

        signal.addEventListener(
          'abort',
          () => {
            if (timeoutId !== null) {
              clearTimeout(timeoutId);
            }
            resolve();
          },
          { once: true },
        );
      });
    },

    async triggerAction(deviceId: string, action): Promise<void> {
      if (action !== 'water') throw new Error(`Unsupported action: ${action}`);
      applyMockWatering(deviceId, 'Watering trigger (mock)');
    },

    async readPlantDrCalibration(deviceId: string): Promise<PlantDrCalibration> {
      const pot = pots.get(deviceId);
      if (!pot) throw new Error(`Mock device ${deviceId} inconnu`);
      return pot.plantDr;
    },

    async writePlantDrCalibration(deviceId: string, values: PlantDrWriteValues): Promise<void> {
      const pot = pots.get(deviceId);
      if (!pot) throw new Error(`Mock device ${deviceId} inconnu`);
      pot.plantDr = {
        dryN: values.dryN,
        dryVwcPercent: values.dryVwcRaw / 10,
        wetN: values.wetN,
        wetVwcPercent: values.wetVwcRaw / 10,
        configId: values.configId,
      };
      log({
        direction: 'WRITE',
        label: 'Plant Dr calibration written (mock)',
        deviceId,
        result: 'OK',
        detail: `dry=${pot.plantDr.dryVwcPercent}% wet=${pot.plantDr.wetVwcPercent}% configId=${pot.plantDr.configId}`,
      });
    },

    async readWateringConfig(deviceId: string): Promise<WateringConfigRaw> {
      const pot = pots.get(deviceId);
      if (!pot) throw new Error(`Mock device ${deviceId} inconnu`);
      return pot.wateringConfig;
    },

    async writeWateringConfig(deviceId: string, values: WateringConfigWriteValues): Promise<void> {
      const pot = pots.get(deviceId);
      if (!pot) throw new Error(`Mock device ${deviceId} inconnu`);
      // Mirrors the real device's own commit rule (wateringConfig.ts): only "persist" if the
      // caller wrote a CONFIG_ID that actually matches the 12 fields it just sent — a mock that
      // always accepted every write regardless of CONFIG_ID couldn't have caught the bug this
      // checksum exists to catch.
      if (values.configId === computeWateringConfigId(values)) {
        pot.wateringConfig = { ...values, algorithmEnabled: values.mode === 1 };
        log({
          direction: 'WRITE',
          label: 'Watering config written (mock)',
          deviceId,
          result: 'OK',
          detail: JSON.stringify(pot.wateringConfig),
        });
      } else {
        log({
          direction: 'WRITE',
          label: 'Watering config write rejected (mock) — CONFIG_ID mismatch',
          deviceId,
          result: 'ERROR',
          detail: `expected configId=${computeWateringConfigId(values)}, got ${values.configId}`,
        });
      }
    },
  };
}
