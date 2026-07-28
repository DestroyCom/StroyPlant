import type { TriggerSource } from '@prisma/client';
import type { ConnectionQueue } from './ble/connectionQueue.js';
import { prisma } from './db/client.js';
import { log } from './logger.js';
import type { DeviceProvider } from './providers/types.js';

export interface WateringResult {
  success: boolean;
  errorDetail?: string;
}

// Shared by the manual trigger (devices.water) and the auto-watering scheduler (Batch 5) so the
// never-fire-and-forget contract (docs/STROYPLANT_SPEC.md section 7.1, identified WatchFlower bug)
// is enforced in exactly one place: every attempt, from either caller, is written to
// WateringEvent with an explicit success/failure, never just logged and dropped.
export async function triggerWatering(
  deviceId: string,
  triggerSource: TriggerSource,
  provider: DeviceProvider,
  connectionQueue: ConnectionQueue,
): Promise<WateringResult> {
  try {
    await connectionQueue.run(() => provider.triggerAction(deviceId, 'water'));
    await prisma.wateringEvent.create({ data: { deviceId, triggerSource, success: true } });
    return { success: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await prisma.wateringEvent.create({ data: { deviceId, triggerSource, success: false, errorDetail: detail } });
    log({ direction: 'WRITE', label: `${triggerSource} watering trigger failed`, deviceId, result: 'ERROR', detail });
    return { success: false, errorDetail: detail };
  }
}
