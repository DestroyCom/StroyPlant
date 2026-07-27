import type { FastifyInstance } from 'fastify';
import type { ConnectionQueue } from '../../ble/connectionQueue.js';
import { prisma } from '../../db/client.js';
import { log } from '../../logger.js';
import type { DeviceProvider } from '../../providers/types.js';

export interface DevicesRouteDeps {
  provider: DeviceProvider;
  connectionQueue: ConnectionQueue;
}

export function registerDeviceRoutes(app: FastifyInstance, deps: DevicesRouteDeps): void {
  app.get('/api/devices', async () => {
    const devices = await prisma.device.findMany();
    const withLastReading = await Promise.all(
      devices.map(async (device) => {
        const lastReading = await prisma.reading.findFirst({
          where: { deviceId: device.id },
          orderBy: { timestamp: 'desc' },
        });
        return { ...device, lastReading };
      }),
    );
    return withLastReading;
  });

  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>('/api/devices/:id/history', async (request, reply) => {
    const device = await prisma.device.findUnique({ where: { id: request.params.id } });
    if (!device) {
      reply.code(404);
      return { error: 'Device not found' };
    }
    const hours = Number(request.query.hours ?? '24');
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const readings = await prisma.reading.findMany({
      where: { deviceId: device.id, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });
    return readings;
  });

  app.post<{ Params: { id: string } }>('/api/devices/:id/water', async (request, reply) => {
    const device = await prisma.device.findUnique({ where: { id: request.params.id } });
    if (!device) {
      reply.code(404);
      return { error: 'Device not found' };
    }

    try {
      await deps.connectionQueue.run(() => deps.provider.triggerAction(device.id, 'water'));
      await prisma.wateringEvent.create({
        data: { deviceId: device.id, triggerSource: 'MANUAL', success: true },
      });
      return { ok: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Jamais fire-and-forget (STROYPLANT_SPEC.md section 7.1, bug WatchFlower identifié) — l'échec
      // est explicitement journalisé en base ET remonté à l'appelant, pas juste logué côté serveur.
      await prisma.wateringEvent.create({
        data: { deviceId: device.id, triggerSource: 'MANUAL', success: false, errorDetail: detail },
      });
      log({ direction: 'WRITE', label: 'Manual watering trigger failed', deviceId: device.id, result: 'ERROR', detail });
      reply.code(502);
      return { ok: false, error: detail };
    }
  });
}
