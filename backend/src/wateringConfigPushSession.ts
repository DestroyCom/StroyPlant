// Tracks the in-flight/last-outcome state of a device-side autonomous watering config push per
// device, so the triggering mutation (health.assignPlantProfile, schedule.upsert, or the manual
// wateringConfig.push button) can return immediately instead of blocking on the full BLE
// read+write sequence — same reasoning and shape as plantDrCalibrationSession.ts (a config push is
// 3-4 sequential connectionQueue-serialized BLE writes, easily exceeding Cloudflare's ~100s origin
// timeout if awaited inline, see docs/superpowers/specs/2026-08-30-parrot-device-side-autonomous-
// watering-design.md).
export type WateringConfigPushState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: number }
  | { status: 'success'; enabled: boolean; finishedAt: number }
  | { status: 'error'; message: string; finishedAt: number };

const states = new Map<string, WateringConfigPushState>();

export function getWateringConfigPushState(deviceId: string): WateringConfigPushState {
  return states.get(deviceId) ?? { status: 'idle' };
}

export function isWateringConfigPushRunning(deviceId: string): boolean {
  return states.get(deviceId)?.status === 'running';
}

export function setWateringConfigPushState(deviceId: string, state: WateringConfigPushState): void {
  states.set(deviceId, state);
}
