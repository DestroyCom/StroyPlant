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

// Shared by the manual trigger (devices.water), the auto-watering scheduler (Batch 5), and the HA
// MQTT watering button (Batch 7) so the never-fire-and-forget contract (docs/STROYPLANT_SPEC.md
// section 7.1, identified WatchFlower bug) is enforced in exactly one place: every attempt, from
// any caller, is written to WateringEvent with an explicit success/failure, never just logged and
// dropped — and, when MQTT is enabled, also republished to `wateringResultTopic` so the outcome
// stays visible in Home Assistant regardless of which surface triggered it.
export async function triggerWatering(
  deviceId: string,
  triggerSource: TriggerSource,
  provider: DeviceProvider,
  connectionQueue: ConnectionQueue,
): Promise<WateringResult> {
  let result: WateringResult;
  try {
    await connectionQueue.run(() => provider.triggerAction(deviceId, 'water'));
    await prisma.wateringEvent.create({ data: { deviceId, triggerSource, success: true } });
    result = { success: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await prisma.wateringEvent.create({ data: { deviceId, triggerSource, success: false, errorDetail: detail } });
    log({ direction: 'WRITE', label: `${triggerSource} watering trigger failed`, deviceId, result: 'ERROR', detail });
    result = { success: false, errorDetail: detail };
  }

  const mqttState = getMqttState();
  if (mqttState) publishWateringResult(mqttState.client, deviceId, result, mqttState.baseTopic);
  return result;
}
