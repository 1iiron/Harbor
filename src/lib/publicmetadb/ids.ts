import { anidbToMal, anilistToMal, kitsuToMal } from "@/lib/providers/anime-mapping";
import type { PmdbTarget } from "./types";

export type EpisodeIdentity = {
  season: number;
  episode: number;
  imdbSeason?: number;
  imdbEpisode?: number;
};

async function animeIdToMal(harborId: string): Promise<number | null> {
  const n = Number(harborId.split(":")[1]);
  if (!Number.isFinite(n)) return null;
  if (harborId.startsWith("mal:")) return n;
  if (harborId.startsWith("kitsu:")) return kitsuToMal(n).catch(() => null);
  if (harborId.startsWith("anilist:")) return anilistToMal(n).catch(() => null);
  if (harborId.startsWith("anidb:")) return anidbToMal(n).catch(() => null);
  return null;
}

export function stremioIdToPmdbTarget(
  metaId: string,
  episode?: { season: number; episode: number },
  type?: "movie" | "series" | "tv" | string,
): PmdbTarget | null {
  if (!metaId) return null;

  // TMDB ID format: tmdb:movie:123 or tmdb:tv:123 or tmdb:tv:123:1:2
  if (metaId.startsWith("tmdb:")) {
    const parts = metaId.split(":");
    const kind = parts[1];
    const id = Number(parts[2]);
    if (!Number.isFinite(id)) return null;

    if (kind === "movie") {
      return { tmdb_id: id, media_type: "movie" };
    }
    if (kind === "tv") {
      if (parts.length >= 5) {
        const season = Number(parts[3]);
        const ep = Number(parts[4]);
        if (Number.isFinite(season) && Number.isFinite(ep)) {
          return { tmdb_id: id, media_type: "tv", season, episode: ep };
        }
      }
      if (episode) {
        return {
          tmdb_id: id,
          media_type: "tv",
          season: episode.season,
          episode: episode.episode,
        };
      }
      return { tmdb_id: id, media_type: "tv" };
    }
  }

  // IMDb ID format: tt1234567 or tt1234567:1:2
  if (metaId.startsWith("tt")) {
    const parts = metaId.split(":");
    const imdb = parts[0];
    if (!/^tt\d+$/.test(imdb)) return null;

    if (parts.length >= 3) {
      const season = Number(parts[1]);
      const ep = Number(parts[2]);
      if (Number.isFinite(season) && Number.isFinite(ep)) {
        return {
          id_type: "imdb",
          id_value: imdb,
          media_type: "tv",
          season,
          episode: ep,
        };
      }
    }

    if (episode) {
      return {
        id_type: "imdb",
        id_value: imdb,
        media_type: "tv",
        season: episode.season,
        episode: episode.episode,
      };
    }

    return {
      id_type: "imdb",
      id_value: imdb,
      media_type: type === "series" ? "tv" : "movie",
    };
  }

  // MAL format: mal:123
  if (metaId.startsWith("mal:")) {
    const id = metaId.split(":")[1];
    if (!id) return null;
    return {
      id_type: "mal",
      id_value: id,
      media_type: type === "movie" ? "movie" : "tv",
      ...(episode ? { season: episode.season, episode: episode.episode } : {}),
    };
  }

  // AniList format: anilist:123
  if (metaId.startsWith("anilist:")) {
    const id = metaId.split(":")[1];
    if (!id) return null;
    return {
      id_type: "anilist",
      id_value: id,
      media_type: type === "movie" ? "movie" : "tv",
      ...(episode ? { season: episode.season, episode: episode.episode } : {}),
    };
  }

  return null;
}

export async function resolvePmdbEpisodeTarget(
  harborId: string,
  episode: EpisodeIdentity,
  fallbackImdb?: string,
): Promise<PmdbTarget | null> {
  const direct = stremioIdToPmdbTarget(harborId, episode, "series");
  if (direct && (direct.season != null || direct.episode != null)) {
    return direct;
  }
  const season = episode.imdbSeason ?? episode.season;
  const number = episode.imdbEpisode ?? episode.episode;
  if (fallbackImdb && /^tt\d+$/.test(fallbackImdb)) {
    return {
      id_type: "imdb",
      id_value: fallbackImdb,
      media_type: "tv",
      season,
      episode: number,
    };
  }
  const mal = await animeIdToMal(harborId);
  if (mal != null) {
    return {
      id_type: "mal",
      id_value: String(mal),
      media_type: "tv",
      season,
      episode: number,
    };
  }
  return direct;
}

export async function resolvePmdbTarget(
  harborId: string,
  type?: "movie" | "series" | "tv" | string,
): Promise<PmdbTarget | null> {
  const direct = stremioIdToPmdbTarget(harborId, undefined, type);
  if (direct) return direct;
  const mal = await animeIdToMal(harborId);
  if (mal != null) {
    return {
      id_type: "mal",
      id_value: String(mal),
      media_type: type === "movie" ? "movie" : "tv",
    };
  }
  return null;
}
