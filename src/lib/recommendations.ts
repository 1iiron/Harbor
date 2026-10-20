import type { Meta } from "@/lib/cinemeta";
import { cinemetaDetails } from "@/lib/providers/cinemeta-details";
import { tmdbDetails } from "@/lib/providers/tmdb/tmdb-details";

const MAX_ITEMS = 18;

/**
 * Recommendations for the end screen. Uses the same sources the detail page
 * does: TMDB when a key is configured, Cinemeta's related list otherwise.
 *
 * An empty list means the caller should fall back to its normal behaviour
 * rather than show a card with nothing in it.
 */
export async function loadMoreLikeThis(meta: Meta, tmdbKey: string | null): Promise<Meta[]> {
  const detail = tmdbKey
    ? ((await tmdbDetails(tmdbKey, meta).catch(() => null)) ??
      (await cinemetaDetails(meta).catch(() => null)))
    : await cinemetaDetails(meta).catch(() => null);
  if (!detail) return [];

  const seen = new Set<string>([meta.id]);
  const out: Meta[] = [];
  for (const item of [...detail.recommendations, ...detail.similar]) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}
