import type { WebSocket } from 'ws';

const clients = new Set<WebSocket>();

export function registerClient(socket: WebSocket): void {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
}

export function broadcast(payload: unknown): void {
  const message = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}
