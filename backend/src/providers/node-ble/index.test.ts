import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFloatLESafe } from './index.js';

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
