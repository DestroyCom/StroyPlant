import { prisma } from '../db/client.js';
import { env } from '../env.js';
import { factDefinitions } from '../inference/facts/index.js';
import { resolveReferenceProfile } from '../inference/referenceProfile.js';
import { inferenceEngine } from '../inference/registry.js';
import { symptomRules } from '../inference/symptoms/index.js';
import type { DeviceCapabilities, EnvironmentContext, OperationalConstraints } from '../inference/types.js';
import { log } from '../logger.js';
import { collectMainDifferences, toLegacyDeviceHealth } from './inferenceShadowMapping.js';
import type { DeviceForTick } from './scheduler.js';
import { isWithinAllowedWindow, resolveEffectiveSchedule } from './scheduler.js';
import { computeDeviceHealth } from './scoring.js';
import type { HealthSettingsValues } from './settings.js';
import { getCalibration } from './soilConductivityCalibration.js';

// This phase never runs for anything but a named Parrot Pot with a species assigned — the same
// device set scheduler.ts's tick() already queries (see backend/src/health/scheduler.ts's `tick`).
// Hardcoded rather than derived from device.kind since the only Diagnosis that exists today
// (chronic_underwatering) only ever consumes soil-moisture-related fields, which Xiaomi devices
// don't report at all.
const PARROT_POT_CAPABILITIES: DeviceCapabilities = ['soilMoisture', 'temperature', 'luminosity', 'conductivity'];

// Runs the new inference engine alongside the legacy Health Engine for one device, and — if their
// resulting status disagrees — writes a ShadowDivergence row plus a structured log line. Never
// throws in a way that should be allowed to affect the caller's own watering-trigger logic: any
// error here is the caller's responsibility to catch (see scheduler.ts's tick(), which wraps this
// call in its own try/catch, separate from evaluateDevice's).
//
// Deliberately re-fetches readings/wateringEvents and calls computeDeviceHealth() a second time
// rather than threading evaluateDevice's already-computed state out to the caller —
// evaluateDevice's early returns (schedule inactive, outside allowed hours, cooldown active) exit
// before computing health, and refactoring that safety-critical function to expose state on every
// path isn't worth the risk for a handful of devices evaluated once every ~5 minutes. Isolation
// over micro-optimization.
export async function evaluateShadow(device: DeviceForTick, healthSettings: HealthSettingsValues): Promise<void> {
  const since = new Date(Date.now() - healthSettings.baselineWindowDays * 24 * 3600_000);
  const readings = await prisma.reading.findMany({
    where: { deviceId: device.id, timestamp: { gte: since }, source: 'POLL' },
    orderBy: { timestamp: 'asc' },
    include: { rawSensorLog: true },
  });
  const conductivityCalibration = await getCalibration(device.id);
  const legacyHealth = computeDeviceHealth(
    device,
    readings,
    device.plantProfile,
    healthSettings.warmupMinDays,
    conductivityCalibration,
    healthSettings.timezone,
  );

  // Neither engine's status is meaningful yet during warm-up, and 'no_profile' can't be a genuine
  // divergence either (tick()'s own query already filters to plantProfileId != null — this only
  // guards the type-level possibility, not a real runtime case).
  if (legacyHealth.status === 'warming_up' || legacyHealth.status === 'no_profile') return;

  const wateringEvents = await prisma.wateringEvent.findMany({ where: { deviceId: device.id }, orderBy: { timestamp: 'asc' } });

  const environment: EnvironmentContext = {
    deviceKind: device.kind,
    environment: device.environment,
    capabilities: PARROT_POT_CAPABILITIES,
    observationsAvailability: {},
    timezone: healthSettings.timezone,
  };
  const profile = device.plantProfile ? resolveReferenceProfile(device.plantProfile, device.environment) : null;

  const effective = resolveEffectiveSchedule(device, device.schedule);
  const lastWatering = wateringEvents.at(-1) ?? null;
  const cooldownActive = lastWatering != null && Date.now() - lastWatering.timestamp.getTime() < effective.cooldownHours * 3600_000;
  const operational: OperationalConstraints = {
    autoWateringEnabled: effective.active,
    withinAllowedWindow: isWithinAllowedWindow(new Date().getHours(), effective.allowedStartHour, effective.allowedEndHour),
    cooldownActive,
  };

  const inferenceResult = inferenceEngine.run({ readings, wateringEvents }, profile, environment, operational, new Date());
  const mappedInference = toLegacyDeviceHealth(inferenceResult);

  if (mappedInference.status === legacyHealth.status) return;

  // classifyTiers (inference/engine.ts) returns diagnoses in registry order, never sorted by
  // importance — unlike recommendations, already sorted by reconcileRecommendations, so
  // recommendations[0] is correctly "primary" but diagnoses[0] is not. Pick the diagnosis with the
  // highest severity*confidence*coverage instead.
  const primaryDiagnosis =
    [...inferenceResult.diagnoses].sort(
      (a, b) => b.severity * b.confidence * b.coverage.ratio - a.severity * a.confidence * a.coverage.ratio,
    )[0] ?? null;
  const primaryRecommendation = inferenceResult.recommendations[0] ?? null;
  const mainDifferences = collectMainDifferences(inferenceResult.diagnoses, inferenceResult.symptoms, factDefinitions, symptomRules);

  // Same dedup precedent as readings.ts's persistSyncFailure: a persistently-diverging device would
  // otherwise write a near-identical row every scheduler tick (~15min) forever. Skip means skip, not
  // log-but-don't-write — matching the existing precedent's behavior.
  const recentDivergence = await prisma.shadowDivergence.findFirst({
    where: { deviceId: device.id, timestamp: { gte: new Date(Date.now() - env.schedulerTickIntervalMs) } },
    orderBy: { timestamp: 'desc' },
  });
  if (
    recentDivergence &&
    recentDivergence.legacyStatus === legacyHealth.status &&
    recentDivergence.inferenceDiagnosisId === (primaryDiagnosis?.id ?? null) &&
    recentDivergence.inferenceTier === (primaryDiagnosis?.tier ?? null)
  ) {
    return;
  }

  await prisma.shadowDivergence.create({
    data: {
      deviceId: device.id,
      legacyStatus: legacyHealth.status,
      inferenceDiagnosisId: primaryDiagnosis?.id ?? null,
      inferenceTier: primaryDiagnosis?.tier ?? null,
      inferenceSeverity: primaryDiagnosis?.severity ?? null,
      inferenceConfidence: primaryDiagnosis?.confidence ?? null,
      recommendationAction: primaryRecommendation?.action ?? null,
      mainDifferences,
    },
  });

  log({
    direction: 'INFO',
    label: 'Shadow mode: inference engine disagrees with legacy Health Engine',
    deviceId: device.id,
    result: 'OK',
    detail: `legacy=${legacyHealth.status} inference=${mappedInference.status} diagnosis=${primaryDiagnosis?.id ?? 'none'}`,
  });
}
