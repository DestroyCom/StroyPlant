import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading, fakeWateringEvent } from './testHelpers.js';

describe('testHelpers', () => {
  it('fakeReading applies overrides on top of null defaults', () => {
    const reading = fakeReading({ soilMoisturePercent: 42 });
    assert.equal(reading.soilMoisturePercent, 42);
    assert.equal(reading.temperatureC, null);
    assert.equal(reading.source, 'POLL');
    assert.equal(reading.deviceId, 'TEST-DEVICE');
  });

  it('fakeReading assigns a unique id per call', () => {
    const a = fakeReading();
    const b = fakeReading();
    assert.notEqual(a.id, b.id);
  });

  it('fakeWateringEvent defaults to a successful manual trigger', () => {
    const event = fakeWateringEvent();
    assert.equal(event.success, true);
    assert.equal(event.triggerSource, 'MANUAL');
  });
});
