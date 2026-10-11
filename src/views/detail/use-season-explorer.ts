import { useEffect, useMemo, useState } from "react";
import { kitsuToTvdb } from "@/lib/providers/anime-mapping";
import { parseKitsuId } from "@/lib/providers/kitsu";
import { isGenericSeasonName } from "@/lib/season-name";
import type { PickerItem } from "./series-episodes/season-arc-picker";
import {
  tvdbSeasonNames,
  tvdbSeasons,
  tvdbSeriesByRemote,
  type TvdbSeasonInfo,
} from "@/lib/providers/tvdb";
import {
  fetchTvdbSeasonDetails,
  type TvdbSeasonDetails,
} from "@/lib/providers/tvdb-season-details";

const EMPTY_SEASONS = new Map<number, TvdbSeasonInfo>();
const EMPTY_NAMES = new Map<number, string>();
const EMPTY_DETAILS = new Map<number, TvdbSeasonDetails>();

export function useSeasonExplorer({
  metaId,
  imdbId,
  tvdbKey,
  seasonType,
  lang,
  activeSeason,
  enabled = true,
}: {
  metaId: string;
  imdbId?: string | null;
  tvdbKey: string;
  seasonType: string;
  lang: string;
  activeSeason?: number;
  enabled?: boolean;
}) {
  const scope = JSON.stringify([metaId, imdbId, tvdbKey, seasonType, lang, enabled]);
  const [catalog, setCatalog] = useState<{
    scope: string;
    seasons: Map<number, TvdbSeasonInfo>;
    names: Map<number, string>;
  }>();
  const [enriched, setEnriched] = useState<{
    scope: string;
    details: Map<number, TvdbSeasonDetails>;
  }>();
  const [pending, setPending] = useState<{ scope: string; season: number } | null>(null);
  const seasons = catalog?.scope === scope ? catalog.seasons : EMPTY_SEASONS;
  const names = catalog?.scope === scope ? catalog.names : EMPTY_NAMES;
  const details = enriched?.scope === scope ? enriched.details : EMPTY_DETAILS;

  useEffect(() => {
    if (!enabled) return;
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
      if (cancelled) return;
      setCatalog({ scope, seasons: infos, names: EMPTY_NAMES });
      const englishNames =
        seriesId == null
          ? EMPTY_NAMES
          : await tvdbSeasonNames(tvdbKey, seriesId, seasonType).catch(() => EMPTY_NAMES);
      if (!cancelled) setCatalog({ scope, seasons: infos, names: englishNames });
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, metaId, imdbId, tvdbKey, seasonType, enabled]);

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
    names,
    details,
    loading: pending?.scope === scope && pending.season === activeSeason,
  };
}

export function englishSeasonItems(
  items: PickerItem[],
  names: ReadonlyMap<number, string>,
  details: ReadonlyMap<number, TvdbSeasonDetails>,
): PickerItem[] {
  return items.map((item) => {
    const n = item.seasonNumber;
    if (n == null || n < 0) return item;
    const name = details.get(n)?.name || names.get(n) || (n === 0 ? "Specials" : `Season ${n}`);
    return {
      ...item,
      name,
      isGenericName: n === 0 ? name === "Specials" : isGenericSeasonName(name, n),
    };
  });
}

export function useSeasonExplorerView({
  items,
  activeKey,
  ...options
}: Omit<Parameters<typeof useSeasonExplorer>[0], "activeSeason" | "lang"> & {
  items: PickerItem[];
  activeKey: string;
  lang: string;
}) {
  const data = useSeasonExplorer({
    ...options,
    activeSeason: items.find((item) => item.key === activeKey)?.seasonNumber,
  });
  const displayItems = useMemo(
    () => (options.enabled === false ? items : englishSeasonItems(items, data.names, data.details)),
    [items, data.names, data.details, options.enabled],
  );
  return { ...data, items: displayItems };
}
