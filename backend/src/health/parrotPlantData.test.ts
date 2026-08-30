import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildParrotPlantRow, formatParrotCsvRow, normalizeLatinName, parseParrotCsvLine, resolveMatchId } from './parrotPlantData.js';

describe('normalizeLatinName', () => {
  it('unifies the multiplication sign and case', () => {
    assert.equal(normalizeLatinName('Abelia × grandiflora'), normalizeLatinName('Abelia x grandiflora'));
  });

  it('collapses repeated whitespace and trims', () => {
    assert.equal(normalizeLatinName('  Abelia   grandiflora '), 'abelia grandiflora');
  });

  it('does not merge genuinely different cultivars', () => {
    assert.notEqual(normalizeLatinName("Abelia x 'Edward Goucher'"), normalizeLatinName('Abelia x grandiflora'));
  });
});

describe('buildParrotPlantRow', () => {
  it('converts EC from mS/cm to µS/cm', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'Abelia x grandiflora' }, { ec_min: 0.5, ec_max: 5 });
    assert.equal(row.soilConductivityMinUsCm, 500);
    assert.equal(row.soilConductivityMaxUsCm, 5000);
  });

  it('converts DLI from mol/day to mmol/day', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'X' }, { dli_min: 5, dli_max: 20 });
    assert.equal(row.lightMinMmol, 5000);
    assert.equal(row.lightMaxMmol, 20000);
  });

  it('passes dli_max=99 through unit-converted, unchanged — a category-level default kept raw rather than nulled (DestCom, after reviewing the sun-category correlation evidence)', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'X' }, { dli_min: 5, dli_max: 99 });
    assert.equal(row.lightMaxMmol, 99000);
  });

  it('passes ec_min=-1 through unit-converted, unchanged — same raw-not-nulled decision', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'X' }, { ec_min: -1, ec_max: 3 });
    assert.equal(row.soilConductivityMinUsCm, -1000);
    assert.equal(row.soilConductivityMaxUsCm, 3000);
  });

  it('maps vwc_dry/vwc_wet to soil moisture min/max unchanged (already percent)', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'X' }, { vwc_dry: 32, vwc_wet: 66 });
    assert.equal(row.soilMoistureMinPercent, 32);
    assert.equal(row.soilMoistureMaxPercent, 66);
  });

  it('maps the irrigation/command/eco fields and sample count unchanged', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'X' }, { vwc_irr: 32, vwc_cmd: 38, vwc_irr_eco: 26, vwc_cmd_eco: 32, n_wet: 288 });
    assert.equal(row.soilMoistureIrrigatePercent, 32);
    assert.equal(row.soilMoistureCommandPercent, 38);
    assert.equal(row.soilMoistureIrrigateEcoPercent, 26);
    assert.equal(row.soilMoistureCommandEcoPercent, 32);
    assert.equal(row.wetCalibrationSampleCount, 288);
  });

  it('picks the preferred common name when present', () => {
    const row = buildParrotPlantRow(
      {
        id: 2,
        fullname: 'X',
        common_names: [{ common_name: 'Not preferred' }, { common_name: 'Chinese Abelia', preferred: true }],
      },
      {},
    );
    assert.equal(row.commonName, 'Chinese Abelia');
  });

  it('leaves fields null when the source has no value at all', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'X' }, {});
    assert.equal(row.soilMoistureMinPercent, null);
    assert.equal(row.temperatureMinC, null);
    assert.equal(row.commonName, null);
  });

  it('maps the structural/taxonomic fields from the encyclopedia entry unchanged', () => {
    const row = buildParrotPlantRow(
      {
        id: 2,
        fullname: 'X',
        height_min: 150,
        height_max: 185,
        spread_min: 195,
        spread_max: 295,
        hardiness_zone_min_value: '7',
        hardiness_zone_max_value: '9',
        heat_zone_min_value: '7',
        heat_zone_max_value: '9',
        t_dying: -12,
        popularity: 330,
        genus_name: 'Abelia',
        species_name: 'chinensis',
        subspecies_name: undefined,
        latin_name: 'Abelia chinensis',
        taxonomy_group_id: 1358,
        is_taxonomy_group_head: true,
        taxonomy_group_subelements_count: 0,
        tags: 164,
        no_fert: false,
        hidden: false,
        synonyms: 'Abelia rupestris',
        nameFirstLetterLatin: 'A',
        orderIndexForSortingLatin: 0,
        characteristics: { sun: 3, water: 2, fertilizer: 1 },
      },
      { n_irr: 0, n_irr_eco: 0 },
    );
    assert.equal(row.heightMinCm, 150);
    assert.equal(row.heightMaxCm, 185);
    assert.equal(row.spreadMinCm, 195);
    assert.equal(row.spreadMaxCm, 295);
    assert.equal(row.hardinessZoneMinValue, '7');
    assert.equal(row.hardinessZoneMaxValue, '9');
    assert.equal(row.heatZoneMinValue, '7');
    assert.equal(row.heatZoneMaxValue, '9');
    assert.equal(row.tDyingC, -12);
    assert.equal(row.popularity, 330);
    assert.equal(row.genusName, 'Abelia');
    assert.equal(row.speciesName, 'chinensis');
    assert.equal(row.subspeciesName, null);
    assert.equal(row.latinName, 'Abelia chinensis');
    assert.equal(row.taxonomyGroupId, 1358);
    assert.equal(row.isTaxonomyGroupHead, true);
    assert.equal(row.taxonomyGroupSubelementsCount, 0);
    assert.equal(row.tags, 164);
    assert.equal(row.noFert, false);
    assert.equal(row.hidden, false);
    assert.equal(row.synonyms, 'Abelia rupestris');
    assert.equal(row.nameFirstLetterLatin, 'A');
    assert.equal(row.orderIndexForSortingLatin, 0);
    assert.equal(row.sunCategory, 3);
    assert.equal(row.waterCategory, 2);
    assert.equal(row.fertilizerCategory, 1);
    assert.equal(row.irrigateCalibrationSampleCount, 0);
    assert.equal(row.irrigateEcoCalibrationSampleCount, 0);
  });
});

describe('formatParrotCsvRow / parseParrotCsvLine round trip', () => {
  it('round-trips a fully populated row, including the structural fields and a false boolean', () => {
    const row = buildParrotPlantRow(
      {
        id: 2,
        fullname: 'Abelia x grandiflora',
        common_names: [{ common_name: 'Abelia', preferred: true }],
        height_min: 150,
        height_max: 185,
        spread_min: 195,
        spread_max: 295,
        hardiness_zone_min_value: '7',
        hardiness_zone_max_value: '9',
        heat_zone_min_value: '7',
        heat_zone_max_value: '9',
        t_dying: -12,
        popularity: 330,
        genus_name: 'Abelia',
        species_name: 'chinensis',
        latin_name: 'Abelia chinensis',
        taxonomy_group_id: 1358,
        is_taxonomy_group_head: true,
        taxonomy_group_subelements_count: 0,
        tags: 164,
        no_fert: false,
        hidden: false,
        synonyms: 'Abelia rupestris',
        nameFirstLetterLatin: 'A',
        orderIndexForSortingLatin: 0,
        characteristics: { sun: 3, water: 2, fertilizer: 1 },
      },
      {
        dli_min: 5,
        dli_max: 20,
        adt_min: 7,
        adt_max: 40,
        ec_min: 0.5,
        ec_max: 5,
        vwc_dry: 32,
        vwc_wet: 66,
        vwc_irr: 32,
        vwc_cmd: 38,
        vwc_irr_eco: 26,
        vwc_cmd_eco: 32,
        n_wet: 288,
        n_irr: 384,
        n_irr_eco: 672,
      },
    );
    const parsed = parseParrotCsvLine(formatParrotCsvRow(row));
    assert.deepEqual(parsed, row);
    // false must survive the round trip distinctly from null (both serialize to falsy-looking text)
    assert.equal(parsed.noFert, false);
    assert.equal(parsed.hidden, false);
  });

  it('round-trips a row full of nulls', () => {
    const row = buildParrotPlantRow({ id: 7, fullname: 'X' }, {});
    const parsed = parseParrotCsvLine(formatParrotCsvRow(row));
    assert.deepEqual(parsed, row);
    assert.equal(parsed.noFert, null);
  });
});

describe('resolveMatchId', () => {
  it('finds an existing profile by normalized name regardless of the × / x spelling', () => {
    const existing = new Map([[normalizeLatinName('Abelia × grandiflora'), 42]]);
    assert.equal(resolveMatchId('Abelia x grandiflora', existing), 42);
  });

  it('returns undefined for a name with no match', () => {
    const existing = new Map([[normalizeLatinName('Abelia × grandiflora'), 42]]);
    assert.equal(resolveMatchId("Abelia x 'Edward Goucher'", existing), undefined);
  });
});
