import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listKnownAttributeFilters, resolveAttributeLabel, resolveFertilizerTypeLabel } from './parrotFilterLabels.js';

describe('resolveAttributeLabel', () => {
  it('resolves a PT type-dimension value', () => {
    assert.deepEqual(resolveAttributeLabel('PT', 'IP'), { group: 'type', groupLabel: 'Type', valueLabel: "Plante d'intérieur" });
  });

  it('resolves a PT lifetime-dimension value with a different group than type', () => {
    assert.deepEqual(resolveAttributeLabel('PT', 'PE'), { group: 'lifetime', groupLabel: 'Cycle', valueLabel: 'Vivace' });
  });

  it('returns null for a PT value belonging to neither known dimension', () => {
    assert.equal(resolveAttributeLabel('PT', 'AQ'), null);
  });

  it('resolves a leaf color (FO)', () => {
    assert.deepEqual(resolveAttributeLabel('FO', 'GR'), { group: 'leafColor', groupLabel: 'Couleur des feuilles', valueLabel: 'Vert' });
  });

  it('resolves a bloom color (BL)', () => {
    assert.deepEqual(resolveAttributeLabel('BL', 'PI'), { group: 'bloomColor', groupLabel: 'Couleur de floraison', valueLabel: 'Rose' });
  });

  it('resolves a plant shape (SH)', () => {
    assert.deepEqual(resolveAttributeLabel('SH', 'RO'), { group: 'shape', groupLabel: 'Forme de la plante', valueLabel: 'Arrondie' });
  });

  it('resolves a special feature (SF)', () => {
    assert.deepEqual(resolveAttributeLabel('SF', 'AB'), {
      group: 'specialFeatures',
      groupLabel: 'Particularités',
      valueLabel: 'Attire les oiseaux',
    });
  });

  it('returns null for an unknown category entirely', () => {
    assert.equal(resolveAttributeLabel('ZZ', 'AB'), null);
  });

  it('returns null for a known category with an unknown value', () => {
    assert.equal(resolveAttributeLabel('SH', 'ZZ'), null);
  });
});

describe('resolveFertilizerTypeLabel', () => {
  it('resolves a known code', () => {
    assert.equal(resolveFertilizerTypeLabel(4), 'orchidée');
  });

  it('resolves the last known code (22)', () => {
    assert.equal(resolveFertilizerTypeLabel(22), 'légumes du potager');
  });

  it('returns null for an unknown code', () => {
    assert.equal(resolveFertilizerTypeLabel(99), null);
  });
});

describe('listKnownAttributeFilters', () => {
  it('lists exactly 6 logical groups, PT split in two, bloomSeason excluded', () => {
    const groups = listKnownAttributeFilters();
    assert.equal(groups.length, 6);
    const groupNames = groups.map((g) => g.group).sort();
    assert.deepEqual(groupNames, ['bloomColor', 'leafColor', 'lifetime', 'shape', 'specialFeatures', 'type']);
  });

  it('never offers bloomSeason as a filter — real "SN" data uses a different code scheme (0/12 overlap)', () => {
    const groups = listKnownAttributeFilters();
    assert.equal(
      groups.some((g) => g.group === 'bloomSeason'),
      false,
    );
  });

  it('both PT-derived groups carry category "PT"', () => {
    const groups = listKnownAttributeFilters();
    const type = groups.find((g) => g.group === 'type');
    const lifetime = groups.find((g) => g.group === 'lifetime');
    assert.equal(type?.category, 'PT');
    assert.equal(lifetime?.category, 'PT');
  });

  it('the leafColor group has exactly 12 options', () => {
    const groups = listKnownAttributeFilters();
    const leafColor = groups.find((g) => g.group === 'leafColor');
    assert.equal(leafColor?.options.length, 12);
  });
});
