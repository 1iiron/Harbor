import { pmdbRequest } from "./client";
import { isAuthenticated } from "./session";
import type {
  PmdbList,
  PmdbListItem,
  PmdbListItemsResponse,
  PmdbListsResponse,
  PmdbTarget,
} from "./types";

let cachedWatchlistId: string | null = null;

export function clearPmdbWatchlistCache(): void {
  cachedWatchlistId = null;
}

async function getWatchlistId(): Promise<string | null> {
  if (cachedWatchlistId) return cachedWatchlistId;
  try {
    const res = await pmdbRequest<PmdbListsResponse>("/api/external/lists", {
      method: "GET",
    });
    const watchlist = res?.items?.find((l: PmdbList) => l.type === "watchlist");
    if (watchlist?.id) {
      cachedWatchlistId = watchlist.id;
      return watchlist.id;
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchPmdbWatchlist(): Promise<PmdbListItem[]> {
  if (!isAuthenticated()) return [];
  const listId = await getWatchlistId();
  if (!listId) return [];

  try {
    const res = await pmdbRequest<PmdbListItemsResponse>(`/api/external/lists/${encodeURIComponent(listId)}/items`, {
      method: "GET",
    });
    return res?.items ?? [];
  } catch {
    return [];
  }
}

export async function addToPmdbWatchlist(target: PmdbTarget): Promise<boolean> {
  if (!isAuthenticated()) return false;
  const listId = await getWatchlistId();
  if (!listId) return false;

  try {
    await pmdbRequest(`/api/external/lists/${encodeURIComponent(listId)}/items`, {
      method: "POST",
      body: {
        tmdb_id: target.tmdb_id,
        media_type: target.media_type,
        id_type: target.id_type,
        id_value: target.id_value,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function removeFromPmdbWatchlist(target: PmdbTarget): Promise<boolean> {
  if (!isAuthenticated()) return false;
  const listId = await getWatchlistId();
  if (!listId) return false;

  try {
    // Fetch items to find matching itemId
    const items = await fetchPmdbWatchlist();
    const item = items.find((i) => {
      if (target.tmdb_id && i.tmdb_id === target.tmdb_id) return true;
      return false;
    });
    if (!item?.id) return false;

    await pmdbRequest(`/api/external/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(item.id)}`, {
      method: "DELETE",
    });
    return true;
  } catch {
    return false;
  }
}
