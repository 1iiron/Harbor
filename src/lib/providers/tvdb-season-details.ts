import { pickSeasonPoster, tvdbSeasonExtended, tvdbSeasonText, type TvdbSeasonInfo } from "./tvdb";

export type TvdbSeasonDetails = {
  name?: string;
  overview?: string;
};

export type TvdbSeasonArtwork = {
  poster?: string;
  background?: string;
};

/** Text is only needed for the selected season. */
export async function fetchTvdbSeasonDetails(
  apiKey: string,
  season: TvdbSeasonInfo,
  lang: string,
): Promise<TvdbSeasonDetails | null> {
  if (season.id == null) return {};
  const englishRequest = tvdbSeasonText(apiKey, season.id, "eng").catch(() => null);
  const [requested, english] = await Promise.all([
    lang === "eng" ? englishRequest : tvdbSeasonText(apiKey, season.id, lang).catch(() => null),
    englishRequest,
  ]);
  if (!requested && !english) return null;
  return {
    // Original-language names are not a safe fallback for an English title.
    name: english?.name,
    overview: requested?.overview || english?.overview,
  };
}

export async function fetchTvdbSeasonArtwork(
  apiKey: string,
  season: TvdbSeasonInfo,
  lang: string,
): Promise<TvdbSeasonArtwork> {
  if (season.id == null) return { poster: season.image };
  const extended = await tvdbSeasonExtended(apiKey, season.id).catch(() => null);
  const background = [...(extended?.artwork ?? [])]
    // Landscape artwork keeps posters, square icons, and wide banners out of the backdrop.
    .filter((art) => {
      const ratio = Number(art.width) / Number(art.height);
      return ratio >= 1.4 && ratio <= 2 && typeof art.image === "string" && art.image;
    })
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))[0]?.image;
  return {
    poster: pickSeasonPoster({
      artwork: extended?.artwork,
      extendedImage: extended?.image,
      baseImage: season.image,
      lang,
    }),
    background:
      typeof background === "string"
        ? background.startsWith("http")
          ? background
          : `https://artworks.thetvdb.com${background.startsWith("/") ? "" : "/"}${background}`
        : undefined,
  };
}

/** One loader belongs to one explorer scope; changing selection only reprioritizes its queue. */
export function createSeasonArtworkLoader(
  apiKey: string,
  lang: string,
  onLoaded: (season: number, artwork: TvdbSeasonArtwork) => void,
) {
  const queued = new Map<number, TvdbSeasonInfo>();
  const requested = new Set<number>();
  let activeSeason: number | undefined;
  let running = 0;
  let stopped = false;
  const pump = () => {
    while (!stopped && running < 3 && queued.size > 0) {
      const season =
        (activeSeason == null ? undefined : queued.get(activeSeason)) ?? queued.values().next().value!;
      queued.delete(season.number);
      requested.add(season.number);
      running++;
      void fetchTvdbSeasonArtwork(apiKey, season, lang)
        .catch(() => ({ poster: season.image }))
        .then((artwork) => {
          if (!stopped) onLoaded(season.number, artwork);
        })
        .finally(() => {
          running--;
          pump();
        });
    }
  };
  return {
    request(seasons: TvdbSeasonInfo[], selected?: number) {
      if (stopped) return;
      activeSeason = selected;
      queued.clear();
      for (const season of seasons) {
        if (season.number >= 0 && !requested.has(season.number)) queued.set(season.number, season);
      }
      pump();
    },
    dispose() {
      stopped = true;
      queued.clear();
    },
  };
}
