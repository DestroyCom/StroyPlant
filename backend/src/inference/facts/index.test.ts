import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { factDefinitions } from './index.js';

describe('fact registry', () => {
  it('registers exactly the 3 V1-slice facts, each with a unique id', () => {
    const ids = factDefinitions.map((d) => d.id);
    assert.deepEqual(ids.sort(), ['drying_rate_unusually_fast', 'soil_moisture_below_profile_min', 'watering_interval_unusually_long']);
    assert.equal(new Set(ids).size, ids.length);
  });
});
