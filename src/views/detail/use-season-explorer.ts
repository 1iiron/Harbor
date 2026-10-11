import { useEffect, useState } from "react";
import { kitsuToTvdb } from "@/lib/providers/anime-mapping";
import { parseKitsuId } from "@/lib/providers/kitsu";
import { tvdbSeasons, tvdbSeriesByRemote, type TvdbSeasonInfo } from "@/lib/providers/tvdb";
import {
  fetchTvdbSeasonDetails,
  type TvdbSeasonDetails,
} from "@/lib/providers/tvdb-season-details";

const EMPTY_SEASONS = new Map<number, TvdbSeasonInfo>();
const EMPTY_DETAILS = new Map<number, TvdbSeasonDetails>();

export function useSeasonExplorer({
  metaId,
  imdbId,
  tvdbKey,
  seasonType,
  lang,
  activeSeason,
}: {
  metaId: string;
  imdbId?: string | null;
  tvdbKey: string;
  seasonType: string;
  lang: string;
  activeSeason?: number;
}) {
  const scope = JSON.stringify([metaId, imdbId, tvdbKey, seasonType, lang]);
  const [catalog, setCatalog] = useState<{ scope: string; seasons: Map<number, TvdbSeasonInfo> }>();
  const [enriched, setEnriched] = useState<{
    scope: string;
    details: Map<number, TvdbSeasonDetails>;
  }>();
  const [pending, setPending] = useState<{ scope: string; season: number } | null>(null);
  const seasons = catalog?.scope === scope ? catalog.seasons : EMPTY_SEASONS;
  const details = enriched?.scope === scope ? enriched.details : EMPTY_DETAILS;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const kitsuId = parseKitsuId(metaId);
      let seriesId = Number(/^tvdb:(\d+)$/.exec(metaId)?.[1]) || null;
      if (seriesId == null && kitsuId != null)
        seriesId = await kitsuToTvdb(kitsuId).catch(() => null);
      const remoteId = imdbId?.startsWith("tt")
        ? imdbId
        : metaId.startsWith("tt")
          ? metaId
          : /^tmdb:tv:(\d+)$/.exec(metaId)?.[1];
      if (seriesId == null && remoteId)
        seriesId = await tvdbSeriesByRemote(tvdbKey, remoteId).catch(() => null);
      if (cancelled) return;
      const infos =
        seriesId == null
          ? EMPTY_SEASONS
          : await tvdbSeasons(tvdbKey, seriesId, seasonType).catch(() => EMPTY_SEASONS);
      if (!cancelled) setCatalog({ scope, seasons: infos });
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, metaId, imdbId, tvdbKey, seasonType]);

  useEffect(() => {
    const season = activeSeason == null ? undefined : seasons.get(activeSeason);
    if (!season) return;
    let cancelled = false;
    setPending({ scope, season: season.number });
    void fetchTvdbSeasonDetails(tvdbKey, season, lang).then((detail) => {
      if (cancelled) return;
      setEnriched((previous) => {
        const next = new Map(previous?.scope === scope ? previous.details : EMPTY_DETAILS);
        next.set(season.number, detail);
        return { scope, details: next };
      });
      setPending(null);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, seasons, activeSeason, tvdbKey, lang]);

  return {
    seasons,
    details,
    loading: pending?.scope === scope && pending.season === activeSeason,
  };
}
