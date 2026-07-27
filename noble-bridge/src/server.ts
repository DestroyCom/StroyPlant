import websocketPlugin from '@fastify/websocket';
import Fastify from 'fastify';
import { scanContinuous } from './ble-client.js';
import { log } from './logger.js';
import { readParrotSensors, triggerParrotWatering } from './parrot.js';

const PORT = Number(process.env.PORT ?? 4100);

const app = Fastify({ logger: false });
await app.register(websocketPlugin);

app.get('/health', async () => ({ ok: true }));

// Flux continu de découverte — le backend s'y connecte pour construire/mettre à jour sa liste de
// devices. Un seul scan noble actif à la fois sur ce process (limite matérielle d'un adaptateur BLE).
app.get('/scan-stream', { websocket: true }, (socket) => {
  const controller = new AbortController();
  scanContinuous((id, name, rssi) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ id, name, rssi }));
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
  try {
    const reading = await readParrotSensors(request.params.id);
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

app.listen({ port: PORT, host: '127.0.0.1' }, (err, address) => {
  if (err) {
    log({ direction: 'INFO', label: 'noble-bridge failed to start', result: 'ERROR', detail: err.message });
    process.exit(1);
  }
  log({ direction: 'INFO', label: `noble-bridge listening on ${address}`, result: 'OK' });
});
