import type { TriggerSource } from '@prisma/client';
import type { ConnectionQueue } from './ble/connectionQueue.js';
import { prisma } from './db/client.js';
import { log } from './logger.js';
import { getMqttState } from './mqtt/manager.js';
import { publishWateringResult } from './mqtt/publisher.js';
import type { DeviceProvider } from './providers/types.js';

export interface WateringResult {
  success: boolean;
  errorDetail?: string;
}

// Shared by the manual trigger (devices.water — direct path AND the live-connection fast path,
// Task 6), the auto-watering scheduler (Batch 5), and the HA MQTT watering button (Batch 7) so the
// never-fire-and-forget contract (docs/STROYPLANT_SPEC.md section 7.1, identified WatchFlower bug)
// is enforced in exactly one place: every attempt, from any caller, is written to WateringEvent
// with an explicit success/failure, never just logged and dropped — and, when MQTT is enabled,
// also republished to `wateringResultTopic` so the outcome stays visible in Home Assistant
// regardless of which surface triggered it.
export async function recordWateringOutcome(
  deviceId: string,
  triggerSource: TriggerSource,
  result: WateringResult,
): Promise<WateringResult> {
  await prisma.wateringEvent.create({
    data: { deviceId, triggerSource, success: result.success, errorDetail: result.errorDetail },
  });
  if (!result.success) {
    log({ direction: 'WRITE', label: `${triggerSource} watering trigger failed`, deviceId, result: 'ERROR', detail: result.errorDetail });
  }

  const mqttState = getMqttState();
  if (mqttState) publishWateringResult(mqttState.client, deviceId, result, mqttState.baseTopic);
  return result;
}

export async function triggerWatering(
  deviceId: string,
  triggerSource: TriggerSource,
  provider: DeviceProvider,
  connectionQueue: ConnectionQueue,
): Promise<WateringResult> {
  let result: WateringResult;
  try {
    await connectionQueue.run(() => provider.triggerAction(deviceId, 'water'));
    result = { success: true };
  } catch (error) {
    result = { success: false, errorDetail: error instanceof Error ? error.message : String(error) };
  }
  try {
    return await recordWateringOutcome(deviceId, triggerSource, result);
  } catch (error) {
    // recordWateringOutcome itself failing (e.g. a DB error) must still resolve to an explicit
    // failure result, matching this function's documented Promise<WateringResult> contract — never
    // an uncaught throw, even when the failure is in the recording step rather than the watering
    // action itself.
    return { success: false, errorDetail: error instanceof Error ? error.message : String(error) };
  }
}
