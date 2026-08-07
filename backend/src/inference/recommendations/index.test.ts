import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recommendationRules } from './index.js';

describe('recommendation registry', () => {
  it('registers exactly the 1 V1-slice recommendation', () => {
    assert.deepEqual(
      recommendationRules.map((r) => r.id),
      ['trigger_watering'],
    );
  });
});
