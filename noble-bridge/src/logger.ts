export type Direction = 'CONNECT' | 'DISCONNECT' | 'SCAN' | 'READ' | 'WRITE' | 'INFO';
export type Result = 'OK' | 'ERROR' | 'TIMEOUT';

export interface LogFields {
  direction: Direction;
  label: string;
  deviceId?: string;
  uuid?: string;
  payloadHex?: string;
  durationMs?: number;
  sinceConnectMs?: number;
  result: Result;
  detail?: string;
}

export function formatHex(data?: Buffer | Uint8Array): string {
  if (!data || data.length === 0) return '(empty)';
  return (
    Buffer.from(data)
      .toString('hex')
      .match(/.{1,2}/g)
      ?.join(' ') ?? '(empty)'
  );
}

export function log(fields: LogFields): void {
  const parts = [`[${new Date().toISOString()}]`, `[${fields.direction}]`, fields.label];
  if (fields.deviceId) parts.push(`device=${fields.deviceId}`);
  if (fields.uuid) parts.push(`uuid=${fields.uuid}`);
  if (fields.payloadHex !== undefined) parts.push(`payload=${fields.payloadHex}`);
  if (fields.durationMs !== undefined) parts.push(`duration=${fields.durationMs.toFixed(1)}ms`);
  if (fields.sinceConnectMs !== undefined) parts.push(`sinceConnect=${fields.sinceConnectMs.toFixed(1)}ms`);
  parts.push(`result=${fields.result}`);
  if (fields.detail) parts.push(`detail=${fields.detail}`);
  const line = parts.join(' ');

  if (fields.result === 'ERROR' || fields.result === 'TIMEOUT') {
    console.error(line);
  } else {
    console.log(line);
  }
}
