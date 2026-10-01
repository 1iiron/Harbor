import { pmdbRequest } from "./client";
import { isAuthenticated } from "./session";
import type { PmdbTarget, PmdbWatchedItem, PmdbWatchedResponse } from "./types";

let cachedWatchedSet: Set<string> | null = null;
let lastFetchAt = 0;
const CACHE_TTL_MS = 30_000;
const WATCHED_PER_PAGE = 100;
const WATCHED_MAX_PAGES = 25;

export function invalidatePmdbWatchedCache(): void {
  cachedWatchedSet = null;
  lastFetchAt = 0;
}

function watchedQuery(target?: PmdbTarget, page = 1): string {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("perPage", String(WATCHED_PER_PAGE));
  if (target) {
    if (target.tmdb_id) params.set("tmdb_id", String(target.tmdb_id));
    if (target.media_type) params.set("media_type", target.media_type);
    if (target.id_type && target.id_value) {
      params.set("id_type", target.id_type);
      params.set("id_value", target.id_value);
    }
  }
  return `/api/external/watched?${params.toString()}`;
}

async function fetchWatchedPage(target: PmdbTarget | undefined, page: number) {
  return pmdbRequest<PmdbWatchedResponse>(watchedQuery(target, page), { method: "GET" });
}

export async function fetchPmdbWatchedKeySet(target?: PmdbTarget): Promise<Set<string>> {
  if (!isAuthenticated()) return new Set();

  const now = Date.now();
  if (!target && cachedWatchedSet && now - lastFetchAt < CACHE_TTL_MS) {
    return cachedWatchedSet;
  }

  const set = new Set<string>();
  // A targeted fetch belongs to one show, so bare `S:E` keys are safe there.
  // A global fetch spans shows, so only scoped keys may be added.
  const scopedOnly = !target;

  try {
    const first = await fetchWatchedPage(target, 1);
    const items = Array.isArray(first?.items) ? first.items : [];
    for (const item of items) addWatchedKeys(set, item, target, scopedOnly);
    const totalPages = Math.max(1, Number(first?.totalPages ?? 1) || 1);
    const pages = Math.min(totalPages, WATCHED_MAX_PAGES);
    for (let page = 2; page <= pages; page++) {
      try {
        const data = await fetchWatchedPage(target, page);
        if (!Array.isArray(data?.items)) break;
        for (const item of data.items) addWatchedKeys(set, item, target, scopedOnly);
        if (data.items.length === 0) break;
      } catch {
        break;
      }
    }

    if (!target) {
      cachedWatchedSet = set;
      lastFetchAt = now;
    }
  } catch {
    // Return empty or cached set on network failure
    return cachedWatchedSet ?? set;
  }

  return set;
}

function addWatchedKeys(
  set: Set<string>,
  item: PmdbWatchedItem,
  target?: PmdbTarget,
  scopedOnly = false,
): void {
  if (item.media_type === "movie") {
    if (item.tmdb_id) {
      set.add(`tmdb:movie:${item.tmdb_id}`);
    }
    if (target?.id_type === "imdb" && target.id_value) {
      set.add(`imdb:${target.id_value}`);
    }
  } else if (item.media_type === "tv") {
    if (item.season != null && item.episode != null) {
      if (!scopedOnly) {
        set.add(`${item.season}:${item.episode}`);
      }
      if (item.tmdb_id) {
        set.add(`tmdb:tv:${item.tmdb_id}:${item.season}:${item.episode}`);
      }
      if (target?.id_type === "imdb" && target.id_value) {
        set.add(`imdb:${target.id_value}:${item.season}:${item.episode}`);
      }
    }
  }
}

function watchedBody(target: PmdbTarget, watchedAt?: string) {
  const isMovie = target.media_type === "movie";
  return {
    tmdb_id: target.tmdb_id,
    media_type: target.media_type,
    // Movies are title-level; never send season/episode for them.
    ...(isMovie
      ? {}
      : {
          season: target.season,
          episode: target.episode,
        }),
    watched_at: watchedAt ?? new Date().toISOString(),
    id_type: target.id_type,
    id_value: target.id_value,
  };
}

export async function markPmdbWatched(
  target: PmdbTarget,
  watchedAt?: string,
): Promise<boolean> {
  if (!isAuthenticated()) return false;
  invalidatePmdbWatchedCache();

  try {
    await pmdbRequest("/api/external/watched", {
      method: "POST",
      body: watchedBody(target, watchedAt),
    });
    return true;
  } catch (err) {
    console.error("Failed to mark PublicMetaDB watched:", err);
    return false;
  }
}

function unmarkQuery(target: PmdbTarget): string {
  const params = new URLSearchParams();
  if (target.tmdb_id) params.set("tmdb_id", String(target.tmdb_id));
  params.set("media_type", target.media_type);
  if (target.media_type !== "movie") {
    if (target.season != null) params.set("season", String(target.season));
    if (target.episode != null) params.set("episode", String(target.episode));
  }
  if (target.id_type && target.id_value) {
    params.set("id_type", target.id_type);
    params.set("id_value", target.id_value);
  }
  return `/api/external/watched?${params.toString()}`;
}

export async function unmarkPmdbWatched(target: PmdbTarget): Promise<boolean> {
  if (!isAuthenticated()) return false;
  invalidatePmdbWatchedCache();

  try {
    await pmdbRequest(unmarkQuery(target), {
      method: "DELETE",
    });
    return true;
  } catch (err) {
    console.error("Failed to unmark PublicMetaDB watched:", err);
    return false;
  }
}
