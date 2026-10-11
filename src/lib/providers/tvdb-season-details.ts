import { pickSeasonPoster, tvdbSeasonExtended, tvdbSeasonText, type TvdbSeasonInfo } from "./tvdb";

export type TvdbSeasonDetails = { name?: string; overview?: string; poster?: string };

/** Only the selected season needs extended artwork and translated text. */
export async function fetchTvdbSeasonDetails(
  apiKey: string,
  season: TvdbSeasonInfo,
  lang: string,
): Promise<TvdbSeasonDetails> {
  if (season.id == null) return { name: season.name || undefined, poster: season.image };
  const [extended, requested, english] = await Promise.all([
    tvdbSeasonExtended(apiKey, season.id).catch(() => null),
    tvdbSeasonText(apiKey, season.id, lang).catch(() => null),
    lang === "eng"
      ? Promise.resolve(null)
      : tvdbSeasonText(apiKey, season.id, "eng").catch(() => null),
  ]);
  return {
    name: requested?.name || english?.name || extended?.name || season.name || undefined,
    overview: requested?.overview || english?.overview || extended?.overview,
    poster: pickSeasonPoster({
      artwork: extended?.artwork,
      extendedImage: extended?.image,
      baseImage: season.image,
      lang,
    }),
  };
}
