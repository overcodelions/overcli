import { describe, expect, it } from 'vitest';
import { OllamaRecommendedModel } from '@shared/types';
import { catalogYears, filterCatalog, DEFAULT_CATALOG_QUERY } from './catalogFilter';

function model(over: Partial<OllamaRecommendedModel>): OllamaRecommendedModel {
  return {
    tag: 'x',
    displayName: 'X',
    sizeGB: 10,
    license: 'Apache 2.0',
    company: 'Acme',
    country: 'US',
    ...over,
  };
}

const CATALOG: OllamaRecommendedModel[] = [
  model({ tag: 'a', displayName: 'A', releasedAt: '2026-08', sizeGB: 17.7, country: 'CN' }),
  model({ tag: 'b', displayName: 'B', releasedAt: '2025-01', sizeGB: 5.2 }),
  model({ tag: 'c', displayName: 'C', releasedAt: '2026-02', sizeGB: 30, company: 'Globex' }),
  model({ tag: 'd', displayName: 'D', sizeGB: 1 }),
];

const q = (over: Partial<typeof DEFAULT_CATALOG_QUERY> = {}) => ({ ...DEFAULT_CATALOG_QUERY, ...over });

describe('filterCatalog', () => {
  it('defaults to newest first', () => {
    expect(filterCatalog(CATALOG, q()).map((m) => m.tag)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('sinks undated models to the bottom of an oldest-first sort too', () => {
    expect(filterCatalog(CATALOG, q({ sort: 'oldest' })).map((m) => m.tag)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('sorts by size in both directions', () => {
    expect(filterCatalog(CATALOG, q({ sort: 'largest' })).map((m) => m.tag)).toEqual(['c', 'a', 'b', 'd']);
    expect(filterCatalog(CATALOG, q({ sort: 'smallest' })).map((m) => m.tag)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('filters by year, excluding undated models', () => {
    expect(filterCatalog(CATALOG, q({ year: '2026' })).map((m) => m.tag)).toEqual(['a', 'c']);
    expect(filterCatalog(CATALOG, q({ year: '2024' }))).toEqual([]);
  });

  it('combines year with the country and company filters', () => {
    expect(filterCatalog(CATALOG, q({ year: '2026', country: 'CN' })).map((m) => m.tag)).toEqual(['a']);
    expect(filterCatalog(CATALOG, q({ company: 'Globex' })).map((m) => m.tag)).toEqual(['c']);
  });

  it('breaks ties on display name so the order is stable', () => {
    const tied = [
      model({ tag: 'z', displayName: 'Zeta', releasedAt: '2026-08' }),
      model({ tag: 'm', displayName: 'Mu', releasedAt: '2026-08' }),
    ];
    expect(filterCatalog(tied, q()).map((m) => m.tag)).toEqual(['m', 'z']);
  });
});

describe('catalogYears', () => {
  it('lists distinct years newest first and drops undated entries', () => {
    expect(catalogYears(CATALOG)).toEqual(['2026', '2025']);
  });
});
