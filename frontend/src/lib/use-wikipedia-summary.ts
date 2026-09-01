import { useQuery } from '@tanstack/react-query';

// Centralizes the Wikipedia language in one place so a future i18n effort only needs to change
// this — currently hardcoded to match the rest of this French-only app (see CLAUDE.md's Frontend
// section, "the prototype is entirely in French"). Swap this for a real locale lookup once i18n
// exists; every call site already goes through this module rather than hardcoding a language.
const WIKIPEDIA_LANGUAGE = 'fr';

export interface WikipediaSummary {
  pageUrl: string;
  thumbnailUrl: string | null;
}

// The summary API needs an exact (or redirect-resolvable) page title — it has no fuzzy matching.
// Cultivar/hybrid botanical names never have their own Wikipedia article by nomenclature
// convention (a cultivar is a cultivated variant, not a distinct taxon), so querying them verbatim
// reliably 404s: strips a quoted cultivar epithet (e.g. "Abutilon x 'Bella Yellow'" → "Abutilon"),
// collapses the standalone hybrid marker " x " into the genus+epithet it separates (e.g. "Rosa x
// damascena" → "Rosa damascena", which does commonly have an article), and drops a trailing
// "spp."/"sp." (genus with no determined species, e.g. "Acacia spp." → "Acacia") — falling back to
// the genus/base-species article instead of nothing.
function cleanBotanicalNameForWikipedia(name: string): string {
  return name
    .replace(/'[^']*'/g, '')
    .replace(/\s+x\s+/g, ' ')
    .replace(/\s+x\s*$/i, '')
    .replace(/\s+spp?\.?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Wikipedia's REST summary API (`/api/rest_v1/page/summary/<title>`) sets permissive CORS headers
// specifically to support this exact browser-embedding use case — no backend proxy needed, and
// nothing is stored: images/links are resolved live, on demand, per species (never all 9120 up
// front — React Query's cache naturally limits this to whatever the user has actually viewed).
async function fetchWikipediaSummary(rawTitle: string): Promise<WikipediaSummary | null> {
  const title = cleanBotanicalNameForWikipedia(rawTitle) || rawTitle;
  const response = await fetch(`https://${WIKIPEDIA_LANGUAGE}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  if (!response.ok) return null;
  const data = await response.json();
  // A disambiguation page (several species/genera sharing a name) or a redirect-less miss with no
  // real article URL isn't a usable match — treat both as "no article found", same as a 404.
  if (data.type === 'disambiguation' || !data.content_urls?.desktop?.page) return null;
  return {
    pageUrl: data.content_urls.desktop.page as string,
    thumbnailUrl: (data.thumbnail?.source as string | undefined) ?? null,
  };
}

export function wikipediaSearchUrl(query: string): string {
  return `https://${WIKIPEDIA_LANGUAGE}.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
}

// `title` is expected to be a plant's Latin/scientific name (e.g. "Ficus benjamina") — Wikipedia's
// own species article titles are conventionally the Latin binomial, giving a much higher match
// rate than a French common name would. Accepts `undefined` (e.g. while the owning query is still
// loading) so callers can call this hook unconditionally, before any early return, without
// violating the rules of hooks — the query simply stays disabled until a real title is available.
export function useWikipediaSummary(title: string | undefined) {
  return useQuery({
    queryKey: ['wikipedia-summary', WIKIPEDIA_LANGUAGE, title],
    queryFn: () => fetchWikipediaSummary(title as string),
    enabled: Boolean(title),
    staleTime: Number.POSITIVE_INFINITY, // static reference data — never changes within a session
    retry: false, // a missing article is a normal, expected outcome, not a transient failure to retry
  });
}
