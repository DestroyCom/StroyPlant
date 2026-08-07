import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { combineNoisyOr, combineWeightedEvidence, computeCoverage, sigmoid } from './evidence.js';
import type { EvidenceItem } from './types.js';

function item(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return { source: { kind: 'operational', id: 'test' }, weight: 1, strength: 1, confidence: 1, polarity: 'supports', ...overrides };
}

describe('computeCoverage', () => {
  it('is 1 when every item has a non-null strength', () => {
    const coverage = computeCoverage([item({ weight: 1 }), item({ weight: 2 })]);
    assert.equal(coverage.ratio, 1);
    assert.equal(coverage.availableWeight, 3);
    assert.equal(coverage.totalWeight, 3);
  });

  it('reflects the fraction of weight that is actually available', () => {
    const coverage = computeCoverage([item({ weight: 1, strength: 0.5 }), item({ weight: 3, strength: null })]);
    assert.equal(coverage.availableWeight, 1);
    assert.equal(coverage.totalWeight, 4);
    assert.equal(coverage.ratio, 0.25);
  });

  it('is 0 for an empty item list (no division by zero)', () => {
    assert.equal(computeCoverage([]).ratio, 0);
  });
});

describe('combineWeightedEvidence', () => {
  it('computes a plain weighted mean over available items', () => {
    const { value } = combineWeightedEvidence([item({ weight: 1, strength: 0.8 }), item({ weight: 1, strength: 0.4 })]);
    assert.ok(value != null && Math.abs(value - 0.6) < 1e-9);
  });

  it('renormalizes over available weight when an item is missing', () => {
    const { value } = combineWeightedEvidence([item({ weight: 1, strength: 0.8 }), item({ weight: 1, strength: null })]);
    assert.ok(value != null && Math.abs(value - 0.8) < 1e-9);
  });

  it('returns null when every item is missing', () => {
    const { value } = combineWeightedEvidence([item({ strength: null }), item({ strength: null })]);
    assert.equal(value, null);
  });

  it('records missing items in the breakdown with their reason', () => {
    const { breakdown } = combineWeightedEvidence([item({ strength: null, missingReason: 'insufficient_history' })]);
    assert.equal(breakdown.missing.length, 1);
    assert.equal(breakdown.missing[0].reason, 'insufficient_history');
  });

  it('includes items with strength: 0 in the weighted mean (does not exclude)', () => {
    const { value } = combineWeightedEvidence([item({ weight: 1, strength: 0 }), item({ weight: 1, strength: 0.8 })]);
    assert.ok(value != null && Math.abs(value - 0.4) < 1e-9);
  });

  it('strength: 0 (present, negative) differs from strength: null (missing)', () => {
    const { value: withNull } = combineWeightedEvidence([item({ weight: 1, strength: null }), item({ weight: 1, strength: 0.8 })]);
    const { value: withZero } = combineWeightedEvidence([item({ weight: 1, strength: 0 }), item({ weight: 1, strength: 0.8 })]);

    assert.ok(withNull != null && Math.abs(withNull - 0.8) < 1e-9);
    assert.ok(withZero != null && Math.abs(withZero - 0.4) < 1e-9);
    assert.notEqual(withNull, withZero);
  });
});

describe('combineNoisyOr', () => {
  it('returns close to full confidence for one strong supporting item', () => {
    const { confidence } = combineNoisyOr([item({ weight: 1, strength: 1, confidence: 1 })]);
    assert.ok(confidence > 0.99);
  });

  it('is monotonic: a second converging item increases confidence beyond either alone', () => {
    const solo = combineNoisyOr([item({ weight: 1, strength: 0.5, confidence: 1 })]).confidence;
    const combined = combineNoisyOr([
      item({ weight: 1, strength: 0.5, confidence: 1 }),
      item({ weight: 1, strength: 0.5, confidence: 1 }),
    ]).confidence;
    assert.ok(combined > solo);
  });

  it('never exceeds 1 no matter how much supporting evidence converges', () => {
    const items = Array.from({ length: 10 }, () => item({ weight: 1, strength: 0.9, confidence: 1 }));
    assert.ok(combineNoisyOr(items).confidence <= 1);
  });

  it('a contradicting item suppresses confidence', () => {
    const withoutContradiction = combineNoisyOr([item({ weight: 1, strength: 0.9, confidence: 1, polarity: 'supports' })]).confidence;
    const withContradiction = combineNoisyOr([
      item({ weight: 1, strength: 0.9, confidence: 1, polarity: 'supports' }),
      item({ weight: 1, strength: 0.9, confidence: 1, polarity: 'contradicts' }),
    ]).confidence;
    assert.ok(withContradiction < withoutContradiction);
  });

  it('is 0 when no evidence is available at all', () => {
    assert.equal(combineNoisyOr([item({ strength: null })]).confidence, 0);
  });
});

describe('sigmoid', () => {
  it('is exactly 0.5 at the midpoint', () => {
    assert.ok(Math.abs(sigmoid(30, 30, 0.3) - 0.5) < 1e-9);
  });

  it('approaches 1 well above the midpoint and 0 well below it', () => {
    assert.ok(sigmoid(100, 30, 0.3) > 0.999);
    assert.ok(sigmoid(-100, 30, 0.3) < 0.001);
  });
});
