import { buildServer } from './api/server.js';
import { emitReading } from './api/trpc/readingsEmitter.js';
import { serializeReading } from './api/trpc/serialize.js';
import { ConnectionQueue } from './ble/connectionQueue.js';
import { startScanner } from './ble/scanner.js';
import { prisma } from './db/client.js';
import { env } from './env.js';
import { log } from './logger.js';
import { createDeviceProvider } from './providers/factory.js';

async function main() {
  const provider = createDeviceProvider();
  const connectionQueue = new ConnectionQueue();

  log({ direction: 'INFO', label: `Starting StroyPlant backend — provider=${provider.name}`, result: 'OK' });

  startScanner(
    provider,
    {
      async onDeviceSeen(device) {
        await prisma.device.upsert({
          where: { id: device.id },
          create: { id: device.id, kind: device.kind, name: device.name, lastSeenAt: new Date() },
          update: { name: device.name, lastSeenAt: new Date() },
        });
      },
      async onReading(deviceId, kind, reading) {
        const data =
          reading.kind === 'PARROT_POT'
            ? {
                soilMoisturePercent: reading.data.soilMoisturePercent,
                temperatureC: reading.data.temperatureC,
                luminosity: reading.data.luminosity,
                waterTankLevelPercent: reading.data.waterTankLevelPercent,
                soilConductivityEcb: reading.data.soilConductivityEcb,
                soilConductivityEcPorous: reading.data.soilConductivityEcPorous,
              }
            : {
                temperatureC: reading.data.temperatureC,
                humidityPercent: reading.data.humidityPercent,
                batteryPercent: reading.data.batteryPercent,
              };

        const created = await prisma.reading.create({ data: { deviceId, ...data } });
        emitReading({ deviceId, kind, reading: serializeReading(created) });
      },
    },
    connectionQueue,
    env.parrotPollIntervalMs,
  );

  const app = await buildServer(provider, connectionQueue);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  log({ direction: 'INFO', label: `API listening on port ${env.port}`, result: 'OK' });
}

main().catch((error) => {
  log({ direction: 'INFO', label: 'Fatal startup error', result: 'ERROR', detail: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
