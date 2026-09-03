import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GattCharacteristic, GattServer, GattService } from 'node-ble';
import { readFloatLESafe, trackAllGattCharacteristics } from './index.js';

// Real-hardware incident (2026-08-31, ~21h of zero Parrot Pot readings): a truncated GATT
// response for a Live-service float32 sensor (fa07/fa09/fa0b) made Buffer.readFloatLE(0) throw a
// bare RangeError, either deep inside readSensors (after wasting ~300 lines of subsequent reads,
// mislabeled as a connection failure) or as an uncaught synchronous throw inside subscribeLive's
// notification handlers. readFloatLESafe centralizes the length check both call sites need.

test('readFloatLESafe decodes a valid 4-byte float32 buffer', () => {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(32.5, 0);
  assert.equal(readFloatLESafe(buf, 'soilMoisturePercent (fa07)'), 32.5);
});

test('readFloatLESafe throws a RangeError, not the raw Buffer error, on a 1-byte buffer', () => {
  const buf = Buffer.from([0x00]);
  assert.throws(
    () => readFloatLESafe(buf, 'soilMoisturePercent (fa07)'),
    (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.match((error as Error).message, /Malformed soilMoisturePercent \(fa07\) buffer: 1 byte\(s\), expected 4 \(hex=00\)/);
      return true;
    },
  );
});

test('readFloatLESafe throws on an empty buffer', () => {
  assert.throws(() => readFloatLESafe(Buffer.alloc(0), 'luminosity (fa0b)'), RangeError);
});

test('readFloatLESafe decodes correctly even when the buffer has extra trailing bytes', () => {
  // Real captures occasionally show longer-than-expected buffers on some characteristics —
  // readFloatLE(0) only reads the first 4 bytes, so this must not be treated as malformed.
  const buf = Buffer.alloc(6);
  buf.writeFloatLE(-4.5, 0); // exactly representable in float32, avoids a precision-mismatch assertion
  assert.equal(readFloatLESafe(buf, 'temperatureC (fa09)'), -4.5);
});

// Production incident (2026-09-03): device.gatt() enumerates every characteristic on every
// service to build node-ble's internal by-uuid map, and that enumeration alone registers a D-Bus
// PropertiesChanged listener per characteristic (GattCharacteristic hardcodes usePropsEvents:
// true) — regardless of whether this file ever reads/writes it. Only characteristics fetched via
// trackedCharacteristic() were ever released, so every untouched one (fa0c/fa0d/fa0e, standard
// GAP/GATT/DeviceInfo characteristics, ...) leaked one match rule per successful connect,
// surfacing in production as a growing MaxListenersExceededWarning on a heavily-polled real pot —
// the same match-rule-leak class that caused the original Round 1 crash. trackAllGattCharacteristics
// closes this by discovering every characteristic gatt() already registered a listener for, so the
// caller's existing release loop covers them too.
function fakeService(characteristicUuids: string[]): GattService {
  return {
    characteristics: async () => characteristicUuids,
    getCharacteristic: async (uuid: string) => ({ __uuid: uuid }) as unknown as GattCharacteristic,
  } as unknown as GattService;
}

test('trackAllGattCharacteristics discovers every characteristic on every service, not just the ones read/written', async () => {
  const fakeServer: GattServer = {
    services: async () => ['service-a', 'service-b'],
    getPrimaryService: async (uuid: string) => (uuid === 'service-a' ? fakeService(['char-1', 'char-2']) : fakeService(['char-3'])),
  } as unknown as GattServer;

  const tracked: GattCharacteristic[] = [];
  await trackAllGattCharacteristics(fakeServer, tracked);

  assert.deepEqual(
    tracked.map((c) => (c as unknown as { __uuid: string }).__uuid),
    ['char-1', 'char-2', 'char-3'],
  );
});

test('trackAllGattCharacteristics never throws — enumeration failing must not fail the caller (spec 7.1)', async () => {
  const fakeServer: GattServer = {
    services: async () => {
      throw new Error('D-Bus enumeration failed');
    },
    getPrimaryService: async () => {
      throw new Error('unreachable');
    },
  } as unknown as GattServer;

  const tracked: GattCharacteristic[] = [];
  await assert.doesNotReject(trackAllGattCharacteristics(fakeServer, tracked));
  assert.deepEqual(tracked, []);
});
