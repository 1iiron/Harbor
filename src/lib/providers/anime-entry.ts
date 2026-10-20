import { animeKitsuMeta, type AnimeKitsuMeta } from "@/lib/providers/anime-kitsu-addon";
import { externalToKitsu } from "@/lib/providers/anime-mapping";
import { parseKitsuId } from "@/lib/providers/kitsu";

export type AnimeEntry = {
  kitsuId: number;
  meta: AnimeKitsuMeta | null;
};

const EXTERNAL: Array<[prefix: string, source: string]> = [
  ["mal:", "myanimelist"],
  ["anilist:", "anilist"],
  ["anidb:", "anidb"],
];

/**
 * Resolve an anime meta id to the Kitsu entry Harbor should use.
 *
 * The addon is asked with the original id first. It is the same source the
 * Continue Watching card and the anime detail page use for display, and it
 * publishes a newly announced sequel before the external id graph links it.
 * ARM is only the fallback, so a missing or stale mapping cannot send an
 * episode list or a detail page to the parent cour.
 */
export async function resolveAnimeEntry(id: string): Promise<AnimeEntry | null> {
  const meta = await animeKitsuMeta(id).catch(() => null);
  const direct = parseKitsuId(meta?.id ?? "");
  if (direct != null) return { kitsuId: direct, meta };
  for (const [prefix, source] of EXTERNAL) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (!Number.isFinite(n)) return null;
    const kitsuId = await externalToKitsu(source, n).catch(() => null);
    return kitsuId != null ? { kitsuId, meta: null } : null;
  }
  return null;
}
