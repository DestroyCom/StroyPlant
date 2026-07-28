import websocketPlugin from '@fastify/websocket';
import Fastify from 'fastify';
import { scanContinuous } from './ble-client.js';
import { log } from './logger.js';
import {
  type PlantDrWriteValues,
  readParrotPlantDrCalibration,
  readParrotSensors,
  triggerParrotWatering,
  writeParrotPlantDrCalibration,
} from './parrot.js';
import { readXiaomiSensors } from './xiaomi.js';

const PORT = Number(process.env.PORT ?? 4100);

const app = Fastify({ logger: false });
await app.register(websocketPlugin);

app.get('/health', async () => ({ ok: true }));

// Continuous discovery stream — the backend connects to it to build/update its device list.
// Only one noble scan active at a time on this process (hardware limit of a single BLE adapter).
app.get('/scan-stream', { websocket: true }, (socket) => {
  const controller = new AbortController();
  scanContinuous((id, kind, name, rssi, advertisementPayloadHex) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ id, kind, name, rssi, advertisementPayloadHex }));
    }
  }, controller.signal).catch((error) => {
    log({
      direction: 'SCAN',
      label: 'scan-stream failed',
      result: 'ERROR',
      detail: error instanceof Error ? error.message : String(error),
    });
  });

  socket.on('close', () => controller.abort());
});

app.post<{ Params: { id: string } }>('/devices/:id/sensors', async (request, reply) => {
  const { id } = request.params;
  try {
    // The logical id encodes the device type (see identifyDevice() in ble-client.ts) — no need for
    // a separate parameter, unlike the node-ble provider which receives a plain MAC.
    const reading = id.startsWith('XIAOMI-') ? await readXiaomiSensors(id) : await readParrotSensors(id);
    return reading;
  } catch (error) {
    reply.code(502);
    return { error: error instanceof Error ? error.message : String(error) };
  }
});

app.post<{ Params: { id: string } }>('/devices/:id/water', async (request, reply) => {
  try {
    await triggerParrotWatering(request.params.id);
    return { ok: true };
  } catch (error) {
    reply.code(502);
    return { error: error instanceof Error ? error.message : String(error) };
  }
});

app.get<{ Params: { id: string } }>('/devices/:id/plant-dr-calibration', async (request, reply) => {
  try {
    return await readParrotPlantDrCalibration(request.params.id);
  } catch (error) {
    reply.code(502);
    return { error: error instanceof Error ? error.message : String(error) };
  }
});

app.post<{ Params: { id: string }; Body: PlantDrWriteValues }>('/devices/:id/plant-dr-calibration', async (request, reply) => {
  try {
    await writeParrotPlantDrCalibration(request.params.id, request.body);
    return { ok: true };
  } catch (error) {
    reply.code(502);
    return { error: error instanceof Error ? error.message : String(error) };
  }
});

app.listen({ port: PORT, host: '127.0.0.1' }, (err, address) => {
  if (err) {
    log({ direction: 'INFO', label: 'noble-bridge failed to start', result: 'ERROR', detail: err.message });
    process.exit(1);
  }
  log({ direction: 'INFO', label: `noble-bridge listening on ${address}`, result: 'OK' });
});
