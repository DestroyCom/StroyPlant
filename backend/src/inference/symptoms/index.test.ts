import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { symptomRules } from './index.js';

describe('symptom registry', () => {
  it('registers exactly the 2 V1-slice symptoms, each with a unique id', () => {
    const ids = symptomRules.map((r) => r.id);
    assert.deepEqual(ids.sort(), ['irregular_watering', 'water_stress']);
    assert.equal(new Set(ids).size, ids.length);
  });
});
