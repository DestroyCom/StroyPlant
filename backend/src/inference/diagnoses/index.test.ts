import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagnosisRules } from './index.js';

describe('diagnosis registry', () => {
  it('registers exactly the 1 V1-slice diagnosis', () => {
    assert.deepEqual(
      diagnosisRules.map((r) => r.id),
      ['chronic_underwatering'],
    );
  });
});
