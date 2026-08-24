import { OllamaRecommendedModel } from '@shared/types';

export type CatalogSort = 'newest' | 'oldest' | 'largest' | 'smallest';

export const CATALOG_SORTS: Array<{ key: CatalogSort; label: string }> = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'largest', label: 'Largest first' },
  { key: 'smallest', label: 'Smallest first' },
];

export interface CatalogQuery {
  country: string;
  company: string;
  year: string;
  sort: CatalogSort;
}

export const DEFAULT_CATALOG_QUERY: CatalogQuery = {
  country: 'all',
  company: 'all',
  year: 'all',
  sort: 'newest',
};

/// `releasedAt` is 'YYYY-MM' where we know it, and absent for the handful of
/// entries whose release date we couldn't pin down. Undated entries stay
/// visible under "All years" but can't match a specific year.
export function modelYear(m: OllamaRecommendedModel): string | undefined {
  const match = /^(\d{4})/.exec(m.releasedAt ?? '');
  return match ? match[1] : undefined;
}

/// Newest year first — a year filter is a "what's current" question, so the
/// current year belongs at the top of the list rather than the bottom.
export function catalogYears(catalog: OllamaRecommendedModel[]): string[] {
  const years = new Set<string>();
  for (const m of catalog) {
    const y = modelYear(m);
    if (y) years.add(y);
  }
  return Array.from(years).sort((a, b) => b.localeCompare(a));
}

function compare(a: OllamaRecommendedModel, b: OllamaRecommendedModel, sort: CatalogSort): number {
  if (sort === 'largest') return b.sizeGB - a.sizeGB;
  if (sort === 'smallest') return a.sizeGB - b.sizeGB;
  // Date sorts: undated entries sink to the bottom either way, since
  // "oldest first" shouldn't be led by models whose age we don't know.
  const av = a.releasedAt ?? '';
  const bv = b.releasedAt ?? '';
  if (!av && !bv) return 0;
  if (!av) return 1;
  if (!bv) return -1;
  return sort === 'newest' ? bv.localeCompare(av) : av.localeCompare(bv);
}

export function filterCatalog(
  catalog: OllamaRecommendedModel[],
  query: CatalogQuery,
): OllamaRecommendedModel[] {
  const { country, company, year, sort } = query;
  return catalog
    .filter(
      (m) =>
        (country === 'all' || m.country === country) &&
        (company === 'all' || m.company === company) &&
        (year === 'all' || modelYear(m) === year),
    )
    // Ties (same month, same size) keep a stable, readable order rather than
    // whatever the sort implementation happens to do.
    .sort((a, b) => compare(a, b, sort) || a.displayName.localeCompare(b.displayName));
}
