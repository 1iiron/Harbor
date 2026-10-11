import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  Download,
  Info,
  Layers,
  ListVideo,
  LoaderCircle,
  Play,
  RefreshCw,
  Server,
  Wand2,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Poster } from "@/components/poster";
import { VirtualGrid } from "@/components/virtual-grid";
import type { Meta } from "@/lib/cinemeta";
import {
  mediaServerConnections,
  mediaServerToken,
  subscribeMediaServerConnections,
} from "@/lib/media-server/connections";
import {
  mediaServerItems,
  mediaServerMetadata,
  putMediaServerMetadata,
  setManualMapping,
} from "@/lib/media-server/index-store";
import { dedupePhysicalEpisodeItems, groupMediaServerTitles } from "@/lib/media-server/selectors";
import {
  currentMediaServerSyncProgress,
  mediaServerAdapter,
  subscribeMediaServerSyncProgress,
  synchronizeMediaServer,
} from "@/lib/media-server/sync";
import type {
  MediaServerCollection,
  MediaServerConnection,
  MediaServerItem,
  MediaServerTitle,
} from "@/lib/media-server/types";
import { useSettings } from "@/lib/settings";
import { useT } from "@/lib/i18n";
import { useView } from "@/lib/view";
import { hydrateLibraryMeta } from "./hydrate-meta";
import { FilterBar, type TypeKey } from "./shared";
import { useReportFeatured } from "./featured-context";
import { IdentifyModal, type IdentifyResolution } from "./local-tab/identify-modal";
import { CardIconButton } from "./local-tab/card-actions";
import type { LocalEntry } from "@/lib/local-library";
import { openLocalEpisodes } from "@/lib/player/local-episodes-modal";
import { openLocalVersions } from "@/lib/player/local-versions-modal";
import { serverPlayableCopies } from "@/lib/media-server/selectors";
import { enqueueDownload } from "@/lib/download/downloads-store";
import { GenreMenu, SortMenu, type LocalSortKey, type SortDir } from "./local-tab/toolbar";
import { MediaServerBrand } from "@/components/media-server-brand";
import { readLibraryFilterPreferences, writeLibraryFilterPreferences } from "./filter-preferences";

type Card = { title: MediaServerTitle; meta: Meta };
const fallbackMeta = (title: MediaServerTitle): Meta => ({
  id: title.key,
  type: title.kind,
  name: title.fallbackTitle,
  releaseInfo: title.year ? String(title.year) : undefined,
});
const REVIEW_DISMISSED_KEY = "harbor.media-server.review-dismissed.v1";

export function MediaServersTab({ scrollRef }: { scrollRef?: RefObject<HTMLElement | null> }) {
  const t = useT();
  const { settings } = useSettings();
  const { openMeta, openSettings } = useView();
  const initialProgress = currentMediaServerSyncProgress();
  const [items, setItems] = useState<MediaServerItem[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [revision, setRevision] = useState(0);
  const [syncing, setSyncing] = useState(initialProgress?.active ?? false);
  const [loading, setLoading] = useState(true);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const metaCache = useRef(new Map<string, Meta>());
  const [collections, setCollections] = useState<MediaServerCollection[] | null>(null);
  const [activeCollection, setActiveCollection] = useState<MediaServerCollection | null>(null);
  const [collectionIds, setCollectionIds] = useState<Set<string> | null>(null);
  const collectionIdsCache = useRef(new Map<string, Set<string>>());
  const [reviewDismissed, setReviewDismissed] = useState(() => {
    try {
      return localStorage.getItem(REVIEW_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const dismissReview = () => {
    setReviewDismissed(true);
    try {
      localStorage.setItem(REVIEW_DISMISSED_KEY, "1");
    } catch {
      /* ignore */
    }
  };
  const [syncMessage, setSyncMessage] = useState(initialProgress?.message ?? "");
  const [reviewing, setReviewing] = useState<MediaServerTitle | null>(null);
  const [syncCount, setSyncCount] = useState<{ processed?: number; total?: number }>({
    processed: initialProgress?.processed,
    total: initialProgress?.total,
  });
  const savedFilters = useMemo(() => readLibraryFilterPreferences("media-servers"), []);
  const [type, setType] = useState<TypeKey>(savedFilters.type ?? "all");
  const [query, setQuery] = useState("");
  const [server, setServer] = useState(savedFilters.server ?? "all");
  const [library, setLibrary] = useState(savedFilters.library ?? "all");
  const [selectedGenres, setSelectedGenres] = useState<Set<string>>(
    () => new Set(savedFilters.genres ?? []),
  );
  const [sort, setSort] = useState<LocalSortKey>(savedFilters.sort ?? "added");
  const [sortDir, setSortDir] = useState<SortDir>(savedFilters.sortDir ?? "desc");
  const connections = useMemo(() => mediaServerConnections(), [revision]);
  useEffect(() => {
    writeLibraryFilterPreferences("media-servers", {
      type,
      genres: [...selectedGenres],
      sort,
      sortDir,
      server,
      library,
    });
  }, [type, selectedGenres, sort, sortDir, server, library]);
  useEffect(() => {
    if (server !== "all" && !connections.some((connection) => connection.id === server))
      setServer("all");
  }, [connections, server]);
  const reload = useCallback(async () => {
    setItems(await mediaServerItems());
    setRevision((value) => value + 1);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
    return subscribeMediaServerConnections(() => {
      setRevision((value) => value + 1);
      void reload();
    });
  }, [reload]);
  useEffect(
    () =>
      subscribeMediaServerSyncProgress((progress) => {
        setSyncing(progress.active);
        setSyncMessage(progress.message);
        setSyncCount({ processed: progress.processed, total: progress.total });
        // Only read the store when the sync finishes. Re-reading mid-sync made
        // the grid and its posters re-render on every page (a visible flicker).
        if (!progress.active) {
          // Collection membership may have changed; drop the cached ids.
          collectionIdsCache.current.clear();
          void reload();
        }
      }),
    [reload],
  );
  const titles = useMemo(
    () =>
      groupMediaServerTitles(
        items.filter((item) =>
          connections.some(
            (connection) => connection.id === item.connectionId && connection.enabled,
          ),
        ),
      ),
    [items, connections],
  );
  const itemByKey = useMemo(
    () => new Map(items.map((item) => [`${item.connectionId}:${item.id}`, item])),
    [items],
  );
  const connectionById = useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection])),
    [connections],
  );
  // The server's own poster is the first choice; TMDB artwork is the fallback.
  const serverPoster = useCallback(
    (title: MediaServerTitle): string | undefined => {
      if (!title.posterPath || !title.posterConnectionId) return undefined;
      const connection = connectionById.get(title.posterConnectionId);
      if (!connection) return undefined;
      let url: URL;
      try {
        url = new URL(title.posterPath.replace(/^\/+/, ""), `${connection.origin}/`);
      } catch {
        return undefined;
      }
      const token = mediaServerToken(connection);
      if (token) {
        if (connection.provider === "plex") url.searchParams.set("X-Plex-Token", token);
        else url.searchParams.set("api_key", token);
      }
      return url.toString();
    },
    [connectionById],
  );
  const collectionPoster = useCallback(
    (collection: MediaServerCollection): string | undefined => {
      if (!collection.posterPath) return undefined;
      const connection = connectionById.get(collection.connectionId);
      if (!connection) return undefined;
      let url: URL;
      try {
        url = new URL(collection.posterPath.replace(/^\/+/, ""), `${connection.origin}/`);
      } catch {
        return undefined;
      }
      const token = mediaServerToken(connection);
      if (token) {
        if (connection.provider === "plex") url.searchParams.set("X-Plex-Token", token);
        else url.searchParams.set("api_key", token);
      }
      return url.toString();
    },
    [connectionById],
  );
  const connectionsKey = connections.map((connection) => connection.id).join(",");
  useEffect(() => {
    let alive = true;
    const capable = connections.filter(
      (connection) => connection.enabled && mediaServerAdapter(connection).collections,
    );
    void Promise.all(
      capable.map((connection) =>
        mediaServerAdapter(connection)
          .collections!(connection)
          .catch(() => [] as MediaServerCollection[]),
      ),
    ).then((lists) => {
      if (alive) setCollections(lists.flat());
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionsKey]);
  useEffect(() => {
    if (!activeCollection) {
      setCollectionIds(null);
      return;
    }
    // Look the connection up at run time instead of depending on the memoized
    // map: the connection list refreshes when a sync finishes, which used to
    // re-run this effect, blank the member set, and empty the collection.
    const connection = mediaServerConnections().find(
      (entry) => entry.id === activeCollection.connectionId,
    );
    const adapter = connection ? mediaServerAdapter(connection) : null;
    if (!connection || !adapter?.collectionItemIds) {
      setCollectionIds(new Set());
      return;
    }
    let alive = true;
    const prefix = `${connection.id}:`;
    const cacheKey = `${connection.id}:${activeCollection.id}`;
    const cached = collectionIdsCache.current.get(cacheKey);
    if (cached) {
      setCollectionIds(cached);
      return;
    }
    setCollectionIds(null);
    void adapter
      .collectionItemIds(connection, activeCollection.id)
      .then((ids) => {
        const set = new Set(ids.map((id) => `${prefix}${id}`));
        collectionIdsCache.current.set(cacheKey, set);
        if (alive) setCollectionIds(set);
      })
      .catch(() => {
        if (alive) setCollectionIds(new Set());
      });
    return () => {
      alive = false;
    };
  }, [activeCollection]);
  useEffect(() => {
    if (type !== "collections") setActiveCollection(null);
  }, [type]);
  useEffect(() => {
    if (loading || library === "all") return;
    if (!items.some((item) => item.libraryId === library)) setLibrary("all");
  }, [items, library, loading]);
  useEffect(() => {
    if (loading) return;
    let alive = true;
    setMetadataLoading(true);
    const languageKey = `${settings.tmdbLanguage || "en"}:${(settings.tmdbImageLangs ?? []).join(",")}`;
    const metaKey = (title: MediaServerTitle) => `${title.key}:locale:${languageKey}`;
    // Paint the grid immediately from cached metadata (session cache first,
    // then the index store) or the filename fallback. A large library must not
    // sit blank while every title's metadata is fetched one by one.
    void (async () => {
      const initial = await Promise.all(
        titles.map(async (title) => {
          const key = metaKey(title);
          let meta = metaCache.current.get(key);
          if (!meta) {
            const cached = await mediaServerMetadata<Meta>(key);
            if (cached) {
              meta = cached;
              metaCache.current.set(key, cached);
            }
          }
          const base = meta ?? fallbackMeta(title);
          const poster = serverPoster(title);
          return { title, meta: poster ? { ...base, poster } : base };
        }),
      );
      if (!alive) return;
      setCards(initial);
      setMetadataLoading(false);
      // While a sync is running, items keep arriving; cached posters still show
      // above, but skip new network fetches until it settles.
      if (syncing) return;
      // Fill in the posters for titles that had nothing cached, updating each
      // card as it lands. A small concurrency pool keeps TMDB traffic sane.
      const pending = initial.filter((card) => !card.meta.poster);
      let index = 0;
      const worker = async () => {
        while (alive && index < pending.length) {
          const card = pending[index++];
          const resolved = await hydrateLibraryMeta(card.title.key, card.title.kind, settings.tmdbKey).catch(
            () => null,
          );
          if (!alive || !resolved) continue;
          const poster = serverPoster(card.title);
          const meta = poster ? { ...resolved, poster } : resolved;
          metaCache.current.set(metaKey(card.title), meta);
          await putMediaServerMetadata(metaKey(card.title), meta);
          if (!alive) return;
          setCards((current) =>
            current.map((entry) => (entry.title.key === card.title.key ? { ...entry, meta } : entry)),
          );
        }
      };
      void Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker));
    })();
    return () => {
      alive = false;
    };
  }, [loading, titles, settings.tmdbKey, settings.tmdbLanguage, settings.tmdbImageLangs, syncing, serverPoster]);
  useEffect(() => {
    if (!loading && !metadataLoading && !syncing) {
      setShowLoading(false);
      return;
    }
    setShowLoading(false);
    const timer = window.setTimeout(() => setShowLoading(true), 250);
    return () => window.clearTimeout(timer);
  }, [loading, metadataLoading, syncing]);
  useReportFeatured(useMemo(() => cards.map((card) => card.meta), [cards]));
  const counts = useMemo(
    () => ({
      all: titles.length,
      movie: titles.filter((title) => title.kind === "movie").length,
      series: titles.filter((title) => title.kind === "series").length,
    }),
    [titles],
  );
  const genres = useMemo(
    () =>
      [...new Set(cards.flatMap((card) => card.meta.genres ?? []))].sort().map((name) => ({
        name,
        count: cards.filter((card) => card.meta.genres?.includes(name)).length,
      })),
    [cards],
  );
  const visible = useMemo(() => {
    if (type === "collections") {
      if (!activeCollection || !collectionIds) return [];
      return cards.filter((card) => card.title.itemKeys.some((key) => collectionIds.has(key)));
    }
    const mul = sortDir === "asc" ? 1 : -1;
    return cards
      .filter(
        (card) =>
          (type === "all" || card.title.kind === type) &&
          (server === "all" || card.title.connectionIds.includes(server)) &&
          (library === "all" || card.title.libraryIds.includes(library)) &&
          [...selectedGenres].every((name) => card.meta.genres?.includes(name)) &&
          (!query.trim() || card.meta.name.toLowerCase().includes(query.trim().toLowerCase())),
      )
      .sort((a, b) => {
        if (sort === "title") return mul * a.meta.name.localeCompare(b.meta.name);
        const value = (entry: Card) =>
          sort === "year"
            ? Number(entry.meta.releaseInfo?.slice(0, 4) ?? 0)
            : sort === "rating"
              ? Number(entry.meta.imdbRating ?? 0)
              : sort === "runtime"
                ? Number(entry.meta.runtime?.match(/\d+/)?.[0] ?? 0)
                : (entry.title.addedAt ?? 0);
        return mul * (value(a) - value(b));
      });
  }, [cards, type, server, library, selectedGenres, query, sort, sortDir, activeCollection, collectionIds]);
  const unmatched = titles.filter(
    (title) => !title.identity.tmdbId && !title.identity.imdbId && !title.identity.tvdbId,
  );
  const syncAll = async () => {
    setSyncing(true);
    setSyncMessage(t("Connecting to home servers…"));
    try {
      for (const connection of connections.filter((entry) => entry.enabled))
        await synchronizeMediaServer(connection, setSyncMessage);
      await reload();
    } finally {
      setSyncing(false);
      setSyncMessage("");
    }
  };
  const resolveReview = async (title: MediaServerTitle, resolution: IdentifyResolution) => {
    const targets = items.filter((item) =>
      title.itemKeys.includes(`${item.connectionId}:${item.id}`),
    );
    await Promise.all(
      targets.map((item) =>
        setManualMapping(item.connectionId, item.id, {
          tmdbId: resolution.tmdbId,
          imdbId: resolution.imdbId ?? undefined,
          ...(item.kind === "episode"
            ? { season: item.identity.season, episode: item.identity.episode }
            : {}),
        }),
      ),
    );
    await reload();
  };
  const localTarget = reviewing
    ? ([
        {
          id: reviewing.key,
          path: "",
          filename: reviewing.fallbackTitle,
          title: reviewing.fallbackTitle,
          year: reviewing.year ?? null,
          type: reviewing.kind === "series" ? ("show" as const) : ("movie" as const),
          addedAt: reviewing.addedAt ?? Date.now(),
        },
      ] satisfies LocalEntry[])
    : null;
  const renderCard = useCallback(
    (card: Card) => {
      const physical = card.title.itemKeys.flatMap((key) => {
        const item = itemByKey.get(key);
        return item ? [item] : [];
      });
      const cardConnections = card.title.connectionIds.flatMap((id) => {
        const connection = connectionById.get(id);
        return connection ? [connection] : [];
      });
      return (
        <ServerCard
          card={card}
          physical={physical}
          connections={connections}
          cardConnections={cardConnections}
          onOpen={() => openMeta(card.meta)}
          onReview={() => setReviewing(card.title)}
        />
      );
    },
    [connectionById, connections, itemByKey, openMeta],
  );
  if (connections.length === 0)
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-edge-soft bg-canvas/30 px-8 py-16 text-center">
        <Server size={32} className="text-ink-subtle" />
        <div>
          <h2 className="text-[18px] font-semibold text-ink">
            {t("You haven’t connected a media server")}
          </h2>
          <p className="mt-1 text-[13px] text-ink-muted">
            {t("Connect Jellyfin, Emby, or Plex in Streaming sources.")}
          </p>
        </div>
        <button
          className="rounded-md bg-ink px-4 py-2 text-[12.5px] font-semibold text-canvas"
          onClick={() => {
            sessionStorage.setItem("harbor.settings.streaming.home-servers", "1");
            openSettings("streaming");
          }}
        >
          {t("Connect now")}
        </button>
      </div>
    );
  return (
    <section className="flex flex-col gap-4">
      <FilterBar
        type={type}
        setType={setType}
        query={query}
        setQuery={setQuery}
        counts={counts}
        collections={collections?.length ?? 0}
        trailing={
          <div className="ms-auto flex flex-wrap gap-2">
            <FilterSelect
              value={server}
              onChange={setServer}
              options={[
                { value: "all", label: t("All servers") },
                ...connections.map((connection) => ({
                  value: connection.id,
                  label: connection.name,
                })),
              ]}
            />
            <FilterSelect
              value={library}
              onChange={setLibrary}
              options={[
                { value: "all", label: t("All libraries") },
                ...Array.from(
                  new Map(
                    items.map((item) => [item.libraryId, item.libraryName || item.libraryId]),
                  ).entries(),
                ).map(([id, name]) => ({ value: id, label: name })),
              ]}
            />
            <GenreMenu
              options={genres}
              selected={selectedGenres}
              onToggle={(name) =>
                setSelectedGenres((current) => {
                  const next = new Set(current);
                  if (next.has(name)) next.delete(name);
                  else next.add(name);
                  return next;
                })
              }
              onClear={() => setSelectedGenres(new Set())}
            />
            <SortMenu
              sortKey={sort}
              setSortKey={setSort}
              sortDir={sortDir}
              setSortDir={setSortDir}
            />
            {showLoading && (loading || metadataLoading || syncing) ? (
              <div
                className="flex h-9 items-center gap-2 rounded-full bg-raised px-3.5 text-[12px] font-medium tabular-nums text-ink-muted"
                title={syncMessage || t("Loading your media server library…")}
              >
                <LoaderCircle size={13} className="animate-spin" />
                {syncCount.processed != null && syncCount.total != null
                  ? `${syncCount.processed} / ${syncCount.total}`
                  : t("Loading…")}
              </div>
            ) : (
              <button
                title={t("Refresh")}
                onClick={() => void syncAll()}
                className="grid h-9 w-9 place-items-center rounded-full bg-raised text-ink-muted"
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
        }
      />
      {unmatched.length > 0 && !reviewDismissed && (
        <div className="flex items-center gap-2 rounded-xl bg-amber-500/12 px-3.5 py-2.5 ring-1 ring-amber-500/30">
          <button
            type="button"
            onClick={() => setReviewing(unmatched[0])}
            className="flex flex-1 items-center gap-2 text-start"
          >
            <AlertTriangle size={15} className="text-amber-500" />
            <span className="text-[12.5px] text-ink">
              {t("{n} titles need review — help us identify them.", { n: unmatched.length })}
            </span>
            <span className="ms-auto rounded-full bg-amber-500 px-3 py-1 text-[11px] font-semibold text-black">
              {t("Review")}
            </span>
          </button>
          <button
            type="button"
            aria-label={t("Dismiss")}
            title={t("Dismiss")}
            onClick={dismissReview}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-amber-500/80 transition-colors hover:text-amber-400"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {type === "collections" && !activeCollection ? (
        collections && collections.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-8">
            {collections.map((collection) => {
              const poster = collectionPoster(collection);
              const connection = connectionById.get(collection.connectionId);
              return (
                <button
                  key={`${collection.connectionId}:${collection.id}`}
                  type="button"
                  onClick={() => setActiveCollection(collection)}
                  className="group flex flex-col gap-2 text-start"
                >
                  <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-raised ring-1 ring-edge-soft">
                    {poster ? (
                      <img
                        src={poster}
                        alt={collection.name}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center text-ink-subtle">
                        <Layers size={22} />
                      </div>
                    )}
                  </div>
                  <span className="truncate text-[13px] font-semibold text-ink">{collection.name}</span>
                  <span className="truncate text-[11px] text-ink-subtle">
                    {connection?.name}
                    {collection.childCount != null ? ` · ${collection.childCount}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-edge-soft px-6 py-10 text-center text-[13px] text-ink-muted">
            {t("No collections on these servers.")}
          </div>
        )
      ) : (
        <>
          {type === "collections" && activeCollection && (
            <button
              type="button"
              onClick={() => setActiveCollection(null)}
              className="flex items-center gap-1.5 self-start text-[13px] font-semibold text-ink-muted hover:text-ink"
            >
              <ChevronLeft size={16} />
              {activeCollection.name}
            </button>
          )}
          {type === "collections" && activeCollection && collectionIds == null ? (
            <div className="grid place-items-center py-10 text-ink-subtle">
              <LoaderCircle size={18} className="animate-spin" />
            </div>
          ) : !loading && !metadataLoading && !syncing && visible.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-edge-soft px-6 py-10 text-center text-[13px] text-ink-muted">
              {t("No matches for these filters.")}
            </div>
          ) : (
            visible.length > 0 &&
            (scrollRef ? (
              <VirtualGrid
                items={visible}
                scrollRef={scrollRef}
                minColumnWidth={Math.round(150 * settings.posterScale)}
                gapX={16}
                gapY={32}
                estimateRowHeight={Math.round(150 * settings.posterScale * 1.5) + 46}
                getKey={(card) => card.title.key}
                renderItem={renderCard}
              />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-8">
                {visible.map((card) => (
                  <div key={card.title.key}>{renderCard(card)}</div>
                ))}
              </div>
            ))
          )}
        </>
      )}
      <IdentifyModal
        target={localTarget}
        onClose={() => setReviewing(null)}
        onResolved={(_, resolution) => reviewing && void resolveReview(reviewing, resolution)}
      />
    </section>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-9 items-center gap-1.5 rounded-full bg-raised px-3.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-elevated hover:text-ink"
      >
        {selected?.label}
        <ChevronDown size={13} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <div className="absolute end-0 top-[calc(100%+6px)] z-50 min-w-44 rounded-xl border border-edge bg-elevated p-1 shadow-[0_18px_50px_-15px_rgba(0,0,0,0.7)]">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className={`flex h-9 w-full items-center justify-between gap-3 rounded-lg px-3 text-start text-[13px] ${option.value === value ? "bg-raised text-ink" : "text-ink-muted hover:bg-raised/60 hover:text-ink"}`}
            >
              <span className="truncate">{option.label}</span>
              {option.value === value && <Check size={14} className="text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const ServerCard = memo(function ServerCard({
  card,
  physical,
  connections,
  cardConnections,
  onOpen,
  onReview,
}: {
  card: Card;
  physical: MediaServerItem[];
  connections: MediaServerConnection[];
  cardConnections: MediaServerConnection[];
  onOpen: () => void;
  onReview: () => void;
}) {
  const { openPlayer } = useView();
  const t = useT();
  const matched =
    card.title.identity.tmdbId != null ||
    !!card.title.identity.imdbId ||
    card.title.identity.tvdbId != null;
  const playCopy = (item: MediaServerItem, versionId?: string) => {
    const connection = connections.find((entry) => entry.id === item.connectionId);
    if (!connection) return;
    const quality = connection.preferredQuality;
    void mediaServerAdapter(connection)
      .playback(connection, item, {
        versionId,
        quality,
        startPositionMs: item.progress?.positionMs,
      })
      .then((source) =>
        openPlayer({
          meta: card.meta,
          imdbId: card.title.identity.imdbId,
          episode:
            item.kind === "episode"
              ? { season: item.identity.season ?? 0, episode: item.identity.episode ?? 0 }
              : undefined,
          url: source.url,
          headers: source.headers,
          subtitles: source.subtitles?.map((track) => ({
            id: track.id,
            url: track.url,
            lang: track.language,
            trustedSource: true,
          })),
          title: card.meta.name,
          subtitle: `${connection.name} · ${source.direct ? "Direct play" : "Transcode"}`,
          notWebReady: true,
          resume: (item.progress?.positionMs ?? 0) > 0,
          homeServer: {
            connectionId: connection.id,
            itemId: item.id,
            versionId: source.versionId,
            quality: source.effectiveQuality,
            playbackSessionId: source.playbackSessionId,
          },
        }),
      );
  };
  const playItems = (playableItems: MediaServerItem[], direct = false) => {
    const copies = serverPlayableCopies(playableItems, connections);
    const selectedItem = (copy: (typeof copies)[number]) =>
      playableItems.find(
        (item) => item.connectionId === copy.connectionId && item.id === copy.itemId,
      );
    if (direct && copies.length === 1) {
      const item = selectedItem(copies[0]);
      if (item) playCopy(item, copies[0].version.id);
      return;
    }
    openLocalVersions({
      title: card.meta.name,
      poster: card.meta.poster,
      entries: [],
      onPlayLocal: () => {},
      serverCopies: copies,
      onPlayServer: (copy) => {
        const item = selectedItem(copy);
        if (item) playCopy(item, copy.version.id);
      },
    });
  };
  const downloadItem = async (item: MediaServerItem, episode?: LocalEntry) => {
    const connection = connections.find((entry) => entry.id === item.connectionId);
    if (!connection) return;
    const source = await mediaServerAdapter(connection).playback(connection, item, {
      versionId: item.versions[0]?.id,
      quality: "original",
    });
    await enqueueDownload({
      meta: card.meta,
      episode:
        episode?.season != null && episode.episode != null
          ? { season: episode.season, episode: episode.episode }
          : undefined,
      url: source.url,
      headers: source.headers,
      streamLabel: connection.name,
    });
  };
  const activate = () => {
    if (!matched) return onReview();
    if (card.title.kind === "series") {
      const episodes = dedupePhysicalEpisodeItems(
        physical.filter(
          (item) =>
            item.kind === "episode" &&
            item.identity.season != null &&
            item.identity.episode != null,
        ),
      );
      const synthetic = episodes.map((item): LocalEntry => {
        const version = item.versions[0];
        return {
          id: `${item.connectionId}:${item.id}`,
          path: "",
          filename: version?.filename ?? version?.name ?? item.title,
          title: card.meta.name,
          year: card.title.year ?? null,
          type: "show",
          resolution: version?.resolution,
          size: version?.sizeBytes,
          tmdbId: card.title.identity.tmdbId ?? null,
          imdbId: card.title.identity.imdbId ?? null,
          season: version?.season ?? item.identity.season ?? null,
          episode: version?.episode ?? item.identity.episode ?? null,
          episodeEnd:
            version?.episodeEnd ?? item.identity.episodeEnd ?? item.identity.episode ?? null,
          addedAt: item.addedAt ?? Date.now(),
        };
      });
      const entrySources = Object.fromEntries(
        episodes.map((item) => {
          const connection = connections.find((candidate) => candidate.id === item.connectionId);
          return [
            `${item.connectionId}:${item.id}`,
            {
              kind: "home-server" as const,
              label: connection?.name ?? t("Home server"),
              provider: connection?.provider ?? "jellyfin",
            },
          ];
        }),
      );
      openLocalEpisodes({
        title: card.meta.name,
        tmdbId: card.title.identity.tmdbId ?? null,
        imdbId: card.title.identity.imdbId ?? null,
        poster: card.meta.poster,
        videos: card.meta.videos,
        entries: synthetic,
        entrySources,
        sourceLabel: t("{n} episodes on home servers", { n: episodes.length }),
        onPlayLocal: (entry) => {
          const item = episodes.find(
            (candidate) => `${candidate.connectionId}:${candidate.id}` === entry.id,
          );
          if (item) playCopy(item, item.versions[0]?.id);
        },
        onDownload: async (entry) => {
          const item = episodes.find(
            (candidate) => `${candidate.connectionId}:${candidate.id}` === entry.id,
          );
          if (item) await downloadItem(item, entry);
        },
      });
    } else {
      const movies = physical.filter((item) => item.kind === "movie");
      if (movies.length > 0) playItems(movies);
    }
  };
  const download = async () => {
    const item = physical.find((entry) => entry.kind === "movie");
    if (item) await downloadItem(item);
  };
  return (
    <article className="group flex flex-col gap-2 text-start">
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") activate();
        }}
        className="relative aspect-[2/3] overflow-hidden rounded-xl bg-elevated text-start outline-none focus-visible:ring-2 focus-visible:ring-ink"
      >
        <Poster
          src={card.meta.poster}
          seed={card.title.key}
          lazy
          className="h-full w-full transition-transform group-hover:scale-[1.02]"
        />
        <span className="absolute start-2 top-2 max-w-[70%] rounded-md bg-canvas/85 px-2 py-0.5 text-[10px] font-semibold text-ink">
          {cardConnections[0] && (
            <MediaServerBrand
              provider={cardConnections[0].provider}
              name={
                card.title.connectionIds.length > 1
                  ? `${cardConnections[0].name} +${card.title.connectionIds.length - 1}`
                  : cardConnections[0].name
              }
            />
          )}
        </span>
        <button
          type="button"
          aria-label={t("Play")}
          onClick={(event) => {
            event.stopPropagation();
            activate();
          }}
          className="absolute start-1/2 top-1/2 grid h-12 w-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-ink text-canvas opacity-0 shadow-xl transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Play size={18} fill="currentColor" />
        </button>
        <span className="absolute bottom-2 end-2 inline-flex items-center gap-1 rounded-md bg-canvas/85 px-2 py-0.5 text-[10px] text-ink">
          {card.title.kind === "series" ? <ListVideo size={10} /> : <Layers size={10} />}{" "}
          {card.title.kind === "series" ? card.title.episodeCount : card.title.versionCount}
        </span>
        <div className="absolute end-2 top-2 flex flex-col gap-1.5">
          <CardIconButton title={t("Open details")} onClick={onOpen}>
            <Info size={11} />
          </CardIconButton>
          <CardIconButton title={t("Fix match")} onClick={onReview}>
            <Wand2 size={11} />
          </CardIconButton>
          <CardIconButton
            title={t("Download media")}
            onClick={() => void (card.title.kind === "series" ? activate() : download())}
          >
            <Download size={11} />
          </CardIconButton>
        </div>
      </div>
      <button onClick={activate} className="text-start">
        <p className="truncate text-[13px] font-medium text-ink">{card.meta.name}</p>
        <p className="truncate text-[11.5px] text-ink-subtle">
          {card.meta.releaseInfo ?? ""}
          {card.title.kind === "series"
            ? ` · ${card.title.episodeCount} episodes`
            : card.title.versionCount > 1
              ? ` · ${card.title.versionCount} versions`
              : ""}
        </p>
      </button>
    </article>
  );
});
