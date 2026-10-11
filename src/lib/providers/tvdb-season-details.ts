import { pickSeasonPoster, tvdbSeasonExtended, tvdbSeasonText, type TvdbSeasonInfo } from "./tvdb";

export type TvdbSeasonDetails = {
  name?: string;
  overview?: string;
  poster?: string;
  background?: string;
};

/** Only the selected season needs extended artwork and localized synopsis text. */
export async function fetchTvdbSeasonDetails(
  apiKey: string,
  season: TvdbSeasonInfo,
  lang: string,
): Promise<TvdbSeasonDetails> {
  if (season.id == null) return { poster: season.image };
  const englishRequest = tvdbSeasonText(apiKey, season.id, "eng").catch(() => null);
  const [extended, requested, english] = await Promise.all([
    tvdbSeasonExtended(apiKey, season.id).catch(() => null),
    lang === "eng" ? englishRequest : tvdbSeasonText(apiKey, season.id, lang).catch(() => null),
    englishRequest,
  ]);
  const background = [...(extended?.artwork ?? [])]
    // Landscape artwork keeps posters, square icons, and wide banners out of the backdrop.
    .filter((art) => {
      const ratio = Number(art.width) / Number(art.height);
      return ratio >= 1.4 && ratio <= 2 && typeof art.image === "string" && art.image;
    })
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))[0]?.image;
  return {
    // Original-language names are not a safe fallback for an English title.
    name: english?.name,
    overview: requested?.overview || english?.overview,
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
