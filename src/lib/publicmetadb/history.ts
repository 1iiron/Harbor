import { pmdbRequest } from "./client";
import { isAuthenticated } from "./session";
import type { PmdbTarget, PmdbWatchedItem, PmdbWatchedResponse } from "./types";

let cachedWatchedSet: Set<string> | null = null;
let lastFetchAt = 0;
const CACHE_TTL_MS = 30_000;

export function invalidatePmdbWatchedCache(): void {
  cachedWatchedSet = null;
  lastFetchAt = 0;
}

export async function fetchPmdbWatchedKeySet(target?: PmdbTarget): Promise<Set<string>> {
  if (!isAuthenticated()) return new Set();

  const now = Date.now();
  if (!target && cachedWatchedSet && now - lastFetchAt < CACHE_TTL_MS) {
    return cachedWatchedSet;
  }

  const set = new Set<string>();
  const params = new URLSearchParams();
  params.set("perPage", "100");

  if (target) {
    if (target.tmdb_id) params.set("tmdb_id", String(target.tmdb_id));
    if (target.media_type) params.set("media_type", target.media_type);
    if (target.season != null) params.set("season", String(target.season));
    if (target.episode != null) params.set("episode", String(target.episode));
    if (target.id_type && target.id_value) {
      params.set("id_type", target.id_type);
      params.set("id_value", target.id_value);
    }
  }

  try {
    const data = await pmdbRequest<PmdbWatchedResponse>(
      `/api/external/watched?${params.toString()}`,
      { method: "GET" },
    );

    if (Array.isArray(data?.items)) {
      for (const item of data.items) {
        addWatchedKeys(set, item);
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

function addWatchedKeys(set: Set<string>, item: PmdbWatchedItem): void {
  if (item.media_type === "movie") {
    if (item.tmdb_id) {
      set.add(`tmdb:movie:${item.tmdb_id}`);
    }
  } else if (item.media_type === "tv") {
    if (item.season != null && item.episode != null) {
      set.add(`${item.season}:${item.episode}`);
      if (item.tmdb_id) {
        set.add(`tmdb:tv:${item.tmdb_id}:${item.season}:${item.episode}`);
      }
    }
  }
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
      body: {
        tmdb_id: target.tmdb_id,
        media_type: target.media_type,
        season: target.season,
        episode: target.episode,
        watched_at: watchedAt ?? new Date().toISOString(),
        id_type: target.id_type,
        id_value: target.id_value,
      },
    });
    return true;
  } catch (err) {
    console.error("Failed to mark PublicMetaDB watched:", err);
    return false;
  }
}

export async function unmarkPmdbWatched(target: PmdbTarget): Promise<boolean> {
  if (!isAuthenticated()) return false;
  invalidatePmdbWatchedCache();

  try {
    await pmdbRequest("/api/external/watched", {
      method: "DELETE",
      body: {
        tmdb_id: target.tmdb_id,
        media_type: target.media_type,
        season: target.season,
        episode: target.episode,
        id_type: target.id_type,
        id_value: target.id_value,
      },
    });
    return true;
  } catch (err) {
    console.error("Failed to unmark PublicMetaDB watched:", err);
    return false;
  }
}
