// Tracks the in-flight/last-outcome state of a plantDr.calibrateWet run per device, so the mutation
// itself can return immediately instead of blocking on the full read+write GATT sequence (root
// cause of a real production incident, 2026-08-29: that sequence — 2 sequential connectionQueue-
// serialized BLE operations, each with its own up-to-3-attempt/backoff/adapter-restart retry policy
// — can take well over Cloudflare's ~100s origin timeout, which sits well under SWAG's own 240s
// proxy_read_timeout, so Cloudflare would serve its own 502 HTML page to the browser even on runs
// that the backend went on to complete successfully). Same module-level-singleton-plus-polled-status
// shape as liveSession/manager.ts and discoverySession.ts, chosen over forceSyncAll's "fire and rely
// on an existing DB-persisted side effect" pattern because a calibration write has no such row to
// piggyback on (the device itself is the only source of truth, docs/STROYPLANT_SPEC.md section 7.11).
export type CalibrationRunState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: number }
  | { status: 'success'; dryVwcPercent: number; wetVwcPercent: number; configId: number; finishedAt: number }
  | { status: 'error'; message: string; finishedAt: number };

const states = new Map<string, CalibrationRunState>();

export function getCalibrationRunState(deviceId: string): CalibrationRunState {
  return states.get(deviceId) ?? { status: 'idle' };
}

export function isCalibrationRunning(deviceId: string): boolean {
  return states.get(deviceId)?.status === 'running';
}

export function setCalibrationRunState(deviceId: string, state: CalibrationRunState): void {
  states.set(deviceId, state);
}
