import { getAnimeCwId } from "@/lib/anime-cw-ids";
import {
  animeKitsuMeta,
  type AnimeKitsuMeta,
  type AnimeKitsuVideo,
} from "@/lib/providers/anime-kitsu-addon";
import type { LibraryItem } from "@/lib/stremio";

const ANIME_ID = /^(kitsu|mal|anilist|anidb):/;

export type CwAnimeVideoLookup = (metaId: string) => Promise<AnimeKitsuMeta | null>;

/**
 * Resolve the Kitsu video behind a Continue Watching row, including catalog
 * rows that only recorded an anime mapping. The lookup is injectable for tests.
 */
export async function resolveCwAnimeVideo(
  item: Pick<LibraryItem, "_id" | "state">,
  native: { season: number; episode: number } | null | undefined,
  lookup: CwAnimeVideoLookup = animeKitsuMeta,
): Promise<AnimeKitsuVideo | null> {
  if (!native || !Number.isInteger(native.episode) || native.episode < 1) return null;
  const metaId = ANIME_ID.test(item._id) ? item._id : getAnimeCwId(item._id);
  if (!metaId) return null;
  const meta = await lookup(metaId).catch(() => null);
  if (!meta) return null;
  return (
    meta.videos.find((video) => video.id === item.state?.video_id) ??
    meta.videos.find((video) => video.episode === native.episode) ??
    null
  );
}
