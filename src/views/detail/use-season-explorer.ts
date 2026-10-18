import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { kitsuToTvdb } from "@/lib/providers/anime-mapping";
import { parseKitsuId } from "@/lib/providers/kitsu";
import { isGenericSeasonName } from "@/lib/season-name";
import { fetchTmdbSeasonPoster, resolveSeasonArtworkTmdbId } from "@/lib/providers/tmdb-season-artwork";
import type { PickerItem } from "./series-episodes/season-arc-picker";
import {
  tvdbSeasonNames,
  tvdbSeasons,
  tvdbSeriesByRemote,
  type TvdbSeasonInfo,
} from "@/lib/providers/tvdb";
import {
  createSeasonArtworkLoader,
  fetchTvdbSeasonDetails,
  type TvdbSeasonArtwork,
  type TvdbSeasonDetails,
} from "@/lib/providers/tvdb-season-details";

const EMPTY_SEASONS = new Map<number, TvdbSeasonInfo>();
const EMPTY_NAMES = new Map<number, string>();
const EMPTY_DETAILS = new Map<number, TvdbSeasonDetails>();
const EMPTY_ARTWORK = new Map<number, TvdbSeasonArtwork>();

export function useSeasonExplorer({
  metaId,
  imdbId,
  tvdbKey,
  tmdbKey = "",
  tmdbTvId,
  seasonPosters,
  titlePoster,
  seasonType,
  lang,
  activeSeason,
  enabled = true,
}: {
  metaId: string;
  imdbId?: string | null;
  tvdbKey: string;
  tmdbKey?: string;
  tmdbTvId?: number | null;
  seasonPosters?: Record<number, string>;
  titlePoster?: string;
  seasonType: string;
  lang: string;
  activeSeason?: number;
  enabled?: boolean;
}) {
  const scope = JSON.stringify([metaId, imdbId, tvdbKey, seasonType, lang, enabled]);
  const posterKey = JSON.stringify(seasonPosters ?? {});
  const artworkScope = JSON.stringify([scope, tmdbKey, tmdbTvId, posterKey, titlePoster]);
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
  const [artworkState, setArtworkState] = useState<{
    scope: string;
    artwork: Map<number, TvdbSeasonArtwork>;
  }>();
  const [visible, setVisible] = useState<{ scope: string; seasons: number[] }>();
  const artworkLoader = useRef<{
    scope: string;
    loader: ReturnType<typeof createSeasonArtworkLoader>;
  } | null>(null);
  const artwork = artworkState?.scope === artworkScope ? artworkState.artwork : EMPTY_ARTWORK;
  const onPosterError = useCallback(
    (number: number, url: string) => {
      const current = artworkLoader.current;
      if (current?.scope === artworkScope) current.loader.reject(number, url);
    },
    [artworkScope],
  );
  const setVisibleSeasons = useCallback(
    (numbers: number[]) => {
      const next = [...new Set(numbers.filter((n) => n >= 0))].sort((a, b) => a - b);
      setVisible((previous) =>
        previous?.scope === scope &&
        previous.seasons.length === next.length &&
        previous.seasons.every((n, i) => n === next[i])
          ? previous
          : { scope, seasons: next },
      );
    },
    [scope],
  );
  const seasons = catalog?.scope === scope ? catalog.seasons : EMPTY_SEASONS;
  const names = catalog?.scope === scope ? catalog.names : EMPTY_NAMES;
  const details = enriched?.scope === scope ? enriched.details : EMPTY_DETAILS;
  const catalogReady = catalog?.scope === scope;

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
    if (!enabled) return;
    const posters = JSON.parse(posterKey) as Record<number, string>;
    let tmdbIdRequest: Promise<number | null> | undefined;
    const loader = createSeasonArtworkLoader(tvdbKey, lang, (number, value) => {
      setArtworkState((previous) => {
        const next = new Map(previous?.scope === artworkScope ? previous.artwork : EMPTY_ARTWORK);
        next.set(number, value);
        return { scope: artworkScope, artwork: next };
      });
    }, {
      titlePoster,
      loadFallback: async (number, rejected, signal) => {
        // Other order types need an explicit season mapping before borrowing TMDB art.
        if (seasonType !== "official" && seasonType !== "aired") return undefined;
        const cached = posters[number];
        if (cached && !rejected.has(cached)) return cached;
        if (!tmdbKey) return undefined;
        tmdbIdRequest ??= resolveSeasonArtworkTmdbId(tmdbKey, metaId, imdbId, tmdbTvId);
        const id = await tmdbIdRequest;
        if (signal.aborted) return undefined;
        return id == null ? undefined : fetchTmdbSeasonPoster(tmdbKey, id, number, lang, rejected);
      },
    });
    artworkLoader.current = { scope: artworkScope, loader };
    return () => {
      loader.dispose();
      artworkLoader.current = null;
    };
  }, [
    artworkScope, seasons, tvdbKey, tmdbKey, tmdbTvId, posterKey, titlePoster,
    metaId, imdbId, seasonType, lang, enabled,
  ]);

  useEffect(() => {
    if (!catalogReady) return;
    const numbers = new Set(visible?.scope === scope ? visible.seasons : []);
    if (activeSeason != null && activeSeason >= 0) numbers.add(activeSeason);
    const requested = [...numbers].map((n): TvdbSeasonInfo =>
      seasons.get(n) ?? { id: null, number: n, name: `Season ${n}` },
    );
    artworkLoader.current?.loader.request(requested, activeSeason);
  }, [scope, artworkScope, catalogReady, seasons, visible, activeSeason]);

  useEffect(() => {
    const season = activeSeason == null ? undefined : seasons.get(activeSeason);
    if (!enabled || !season || details.has(season.number)) return;
    let cancelled = false;
    setPending({ scope, season: season.number });
    void fetchTvdbSeasonDetails(tvdbKey, season, lang)
      .catch(() => null)
      .then((detail) => {
        if (cancelled) return;
        if (detail) {
          setEnriched((previous) => {
            const next = new Map(previous?.scope === scope ? previous.details : EMPTY_DETAILS);
            next.set(season.number, detail);
            return { scope, details: next };
          });
        }
        setPending(null);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, seasons, activeSeason, tvdbKey, lang, enabled, details]);

  return {
    seasons,
    names,
    details,
    artwork,
    setVisibleSeasons,
    onPosterError,
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
    const sourceName = item.nameLanguage === "en" ? item.name.trim() : undefined;
    const name =
      details.get(n)?.name || names.get(n) || sourceName ||
      (n === 0 ? "Specials" : `Season ${n}`);
    return {
      ...item,
      name,
      nameLanguage: "en",
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
