import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listKnownTags, resolveTagLabels } from './parrotTags.js';

describe('listKnownTags', () => {
  it('lists exactly the 9 confirmed bits, sorted ascending', () => {
    const tags = listKnownTags();
    assert.deepEqual(
      tags.map((tag) => tag.bit),
      [1, 2, 4, 8, 16, 32, 64, 128, 256],
    );
  });

  it('does not include the unlabeled cannabis bit (512)', () => {
    const tags = listKnownTags();
    assert.equal(
      tags.some((tag) => tag.bit === 512),
      false,
    );
  });

  it('resolves the orchid bit to its known label', () => {
    const tags = listKnownTags();
    const orchid = tags.find((tag) => tag.bit === 256);
    assert.equal(orchid?.label, 'Orchidées et plantes originales');
  });
});

describe('resolveTagLabels', () => {
  it('returns an empty array for null tags', () => {
    assert.deepEqual(resolveTagLabels(null), []);
  });

  it('returns an empty array when no known bit is set', () => {
    assert.deepEqual(resolveTagLabels(512), []);
  });

  it('resolves a single set bit', () => {
    assert.deepEqual(resolveTagLabels(1), ['Cactus et plantes grasses']);
  });

  it('resolves multiple set bits, in ascending bit order', () => {
    assert.deepEqual(resolveTagLabels(1 + 16 + 256), [
      'Cactus et plantes grasses',
      "Plantes d'intérieur",
      'Orchidées et plantes originales',
    ]);
  });

  it('ignores an unlabeled bit mixed in with known ones', () => {
    assert.deepEqual(resolveTagLabels(256 + 512), ['Orchidées et plantes originales']);
  });
});
