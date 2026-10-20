/**
 * Nuvio Library Sync & Storage Module
 * Manages strictly profile-isolated cloud library sync with Supabase PostgREST RPCs.
 * Preserves rich metadata: poster, background, logo, description, releaseInfo, imdbRating, genres.
 */

import { setItemWithRecovery } from "@/lib/storage-recovery";
import { getNuvioAccountId, getOrCreateSyncClientId, isNuvioSignedIn, nuvioFetch } from "./nuvio-client";
import type {
  NuvioLibraryDeltaItem,
  NuvioLibraryItem,
  NuvioLibrarySyncKey,
} from "./nuvio-types";

export type { NuvioLibraryItem };

const LIBRARY_KEY_PREFIX = "harbor.nuvio.library.";
const CURSOR_KEY_PREFIX = "harbor.nuvio.library.cursor.";
const PENDING_UPSERT_KEY_PREFIX = "harbor.nuvio.library.pending_upsert.";
const PENDING_DELETE_KEY_PREFIX = "harbor.nuvio.library.pending_delete.";
const TOMBSTONE_KEY_PREFIX = "harbor.nuvio.library.tombstone.";

function getLibraryKey(slot: number): string {
  const accountId = getNuvioAccountId() || "anon";
  return `${LIBRARY_KEY_PREFIX}${accountId}.slot.${slot}`;
}
function getCursorKey(slot: number): string {
  const accountId = getNuvioAccountId() || "anon";
  return `${CURSOR_KEY_PREFIX}${accountId}.slot.${slot}`;
}
function getPendingUpsertKey(slot: number): string {
  const accountId = getNuvioAccountId() || "anon";
  return `${PENDING_UPSERT_KEY_PREFIX}${accountId}.slot.${slot}`;
}
function getPendingDeleteKey(slot: number): string {
  const accountId = getNuvioAccountId() || "anon";
  return `${PENDING_DELETE_KEY_PREFIX}${accountId}.slot.${slot}`;
}
function getTombstoneKey(slot: number): string {
  const accountId = getNuvioAccountId() || "anon";
  return `${TOMBSTONE_KEY_PREFIX}${accountId}.slot.${slot}`;
}

export function clearNuvioLibraryCache(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("harbor.nuvio.library.")) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch (e) {
    console.warn("[nuvio-library] failed to clear library cache", e);
  }
}
const TOMBSTONE_TTL_MS = 30 * 1000; // 30s TTL to prevent resurrection while avoiding wiping surviving items

interface NuvioTombstone {
  content_id: string;
  content_type: string;
  deleted_at: number;
}

export function readTombstones(slot: number): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const raw = localStorage.getItem(getTombstoneKey(slot));
    if (!raw) return map;
    const list = JSON.parse(raw) as NuvioTombstone[];
    const now = Date.now();
    for (const t of list) {
      if (t && t.content_id && now - t.deleted_at < TOMBSTONE_TTL_MS) {
        map.set(t.content_id, t.deleted_at);
        if (t.content_type) {
          map.set(`${t.content_type}:${t.content_id}`, t.deleted_at);
        }
      }
    }
  } catch {}
  return map;
}

export function recordTombstone(
  slot: number,
  contentId: string,
  contentType: string,
): void {
  if (!contentId || typeof contentId !== "string" || !contentId.trim()) return;
  const cleanId = contentId.trim();
  const cleanType = (contentType || "movie").trim();
  try {
    const raw = localStorage.getItem(getTombstoneKey(slot));
    const list: NuvioTombstone[] = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    const filtered = list.filter(
      (t) => t && t.content_id && now - t.deleted_at < TOMBSTONE_TTL_MS && t.content_id !== cleanId,
    );
    filtered.push({ content_id: cleanId, content_type: cleanType, deleted_at: now });
    localStorage.setItem(getTombstoneKey(slot), JSON.stringify(filtered));
  } catch {}
}

export function clearTombstone(slot: number, contentId: string): void {
  if (!contentId) return;
  const cleanId = contentId.trim();
  try {
    const raw = localStorage.getItem(getTombstoneKey(slot));
    if (!raw) return;
    const list: NuvioTombstone[] = JSON.parse(raw);
    const filtered = list.filter((t) => t && t.content_id !== cleanId);
    if (filtered.length === 0) {
      localStorage.removeItem(getTombstoneKey(slot));
    } else {
      localStorage.setItem(getTombstoneKey(slot), JSON.stringify(filtered));
    }
  } catch {}
}

const subscribers = new Set<(slot: number) => void>();

function notifySubscribers(slot: number): void {
  for (const sub of subscribers) {
    try {
      sub(slot);
    } catch (e) {
      console.warn("[nuvio-library] subscriber error", e);
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("harbor:nuvio-library-changed", { detail: { slot } }),
    );
  }
}

export function subscribeNuvioLibrary(fn: (slot: number) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/**
 * Loads cached library items for a specific profile slot from localStorage,
 * filtering out any currently tombstoned or pending-delete items.
 */
export function readCachedNuvioLibrary(slot: number): NuvioLibraryItem[] {
  try {
    const raw = localStorage.getItem(getLibraryKey(slot));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const tombstones = readTombstones(slot);
    const pendingDeletes = readPendingDeletes(slot);
    const pendingIds = new Set(pendingDeletes.map((k) => k.content_id).filter(Boolean));

    const validItems: NuvioLibraryItem[] = [];
    for (const item of parsed) {
      if (!item || !item.content_id) continue;
      const id = String(item.content_id).trim();
      const type = String(item.content_type || "movie").trim();
      if (
        tombstones.has(id) ||
        tombstones.has(`${type}:${id}`) ||
        pendingIds.has(id)
      ) {
        continue;
      }
      validItems.push(item as NuvioLibraryItem);
    }
    return validItems;
  } catch {
    return [];
  }
}

/**
 * Persists library items for a specific profile slot into localStorage.
 */
export function writeCachedNuvioLibrary(
  slot: number,
  items: NuvioLibraryItem[],
  notify = true,
): void {
  try {
    const valid = items.filter((i) => i && i.content_id && String(i.content_id).trim().length > 0);
    const payload = JSON.stringify(valid);
    setItemWithRecovery(getLibraryKey(slot), payload);
    if (notify) {
      notifySubscribers(slot);
    }
  } catch (e) {
    console.warn(`[nuvio-library] failed to write cache for slot ${slot}`, e);
  }
}

/**
 * Updates cache only if items differ, and notifies subscribers.
 * Prevents recursive sync loops while guaranteeing UI refreshes when remote changes arrive.
 */
export function setCachedNuvioLibraryIfChanged(
  slot: number,
  freshItems: NuvioLibraryItem[],
): boolean {
  try {
    const current = readCachedNuvioLibrary(slot);
    const currentIds = current.map((i) => `${i.content_type}:${i.content_id}`).join("|");
    const freshIds = freshItems.map((i) => `${i.content_type}:${i.content_id}`).join("|");

    if (currentIds === freshIds && current.length === freshItems.length) {
      return false;
    }
    writeCachedNuvioLibrary(slot, freshItems, true);
    return true;
  } catch {
    writeCachedNuvioLibrary(slot, freshItems, true);
    return true;
  }
}

export function readNuvioCursor(slot: number): number | null {
  try {
    const raw = localStorage.getItem(getCursorKey(slot));
    if (!raw) return null;
    const val = parseInt(raw, 10);
    return isNaN(val) ? null : val;
  } catch {
    return null;
  }
}

export function writeNuvioCursor(slot: number, cursor: number): void {
  try {
    localStorage.setItem(getCursorKey(slot), String(cursor));
  } catch {}
}

export function readPendingUpserts(slot: number): NuvioLibraryItem[] {
  try {
    const raw = localStorage.getItem(getPendingUpsertKey(slot));
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((i) => i && i.content_id) : [];
  } catch {
    return [];
  }
}

export function writePendingUpserts(slot: number, items: NuvioLibraryItem[]): void {
  try {
    const valid = items.filter((i) => i && i.content_id && String(i.content_id).trim().length > 0);
    if (valid.length === 0) {
      localStorage.removeItem(getPendingUpsertKey(slot));
    } else {
      localStorage.setItem(getPendingUpsertKey(slot), JSON.stringify(valid));
    }
  } catch {}
}

export function readPendingDeletes(slot: number): NuvioLibrarySyncKey[] {
  try {
    const raw = localStorage.getItem(getPendingDeleteKey(slot));
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((k) => k && k.content_id && String(k.content_id).trim().length > 0) : [];
  } catch {
    return [];
  }
}

export function writePendingDeletes(slot: number, keys: NuvioLibrarySyncKey[]): void {
  try {
    const valid = keys.filter((k) => k && k.content_id && String(k.content_id).trim().length > 0);
    if (valid.length === 0) {
      localStorage.removeItem(getPendingDeleteKey(slot));
    } else {
      localStorage.setItem(getPendingDeleteKey(slot), JSON.stringify(valid));
    }
  } catch {}
}

/**
 * Normalizes raw Supabase row into a type-safe NuvioLibraryItem.
 */
function normalizeLibraryRow(row: unknown): NuvioLibraryItem | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const contentId = String(r.content_id || "").trim();
  if (!contentId) return null;

  return {
    content_id: contentId,
    content_type: String(r.content_type || "movie").trim(),
    name: String(r.name || "").trim(),
    poster: typeof r.poster === "string" && r.poster ? r.poster : null,
    poster_shape: (r.poster_shape as NuvioLibraryItem["poster_shape"]) || "POSTER",
    background: typeof r.background === "string" && r.background ? r.background : null,
    logo: typeof r.logo === "string" && r.logo ? r.logo : null,
    description: typeof r.description === "string" && r.description ? r.description : null,
    release_info: typeof r.release_info === "string" && r.release_info ? r.release_info : null,
    imdb_rating: typeof r.imdb_rating === "number" ? r.imdb_rating : null,
    genres: Array.isArray(r.genres) ? r.genres.map(String).filter(Boolean) : [],
    addon_base_url: typeof r.addon_base_url === "string" && r.addon_base_url ? r.addon_base_url : null,
    added_at: typeof r.added_at === "number" ? r.added_at : Date.now(),
  };
}

/**
 * Pulls full library snapshot via sync_pull_library RPC with pagination,
 * with fallback to direct table query on /rest/v1/library_items.
 * Excludes any tombstoned or pending-delete items to avoid resurrecting deletions.
 */
export async function pullNuvioLibrarySnapshot(
  slot: number,
): Promise<NuvioLibraryItem[]> {
  if (!isNuvioSignedIn()) return readCachedNuvioLibrary(slot);

  const pageSize = 100;
  let offset = 0;
  const collected: NuvioLibraryItem[] = [];
  let rpcSuccess = false;

  try {
    // 1. Get delta cursor before snapshot
    let cursor = 0;
    try {
      const cursorRes = await nuvioFetch("/rest/v1/rpc/sync_get_library_delta_cursor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_profile_id: slot }),
      });
      if (cursorRes.ok) {
        const val = await cursorRes.json();
        if (typeof val === "number") cursor = val;
        else if (typeof val === "string") cursor = parseInt(val, 10) || 0;
      }
    } catch {}

    // 2. Paginate sync_pull_library
    while (true) {
      const res = await nuvioFetch("/rest/v1/rpc/sync_pull_library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          p_profile_id: slot,
          p_limit: pageSize,
          p_offset: offset,
        }),
      });

      if (!res.ok) {
        break;
      }

      const rows = (await res.json()) as unknown;
      if (!Array.isArray(rows)) break;
      rpcSuccess = true;

      for (const row of rows) {
        const item = normalizeLibraryRow(row);
        if (item) collected.push(item);
      }

      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    // 3. Fallback to direct table query if RPC was not successful
    if (!rpcSuccess) {
      try {
        const tableRes = await nuvioFetch(
          `/rest/v1/library_items?profile_id=eq.${slot}&order=added_at.desc&limit=500`,
        );
        if (tableRes.ok) {
          const rows = (await tableRes.json()) as unknown;
          if (Array.isArray(rows)) {
            collected.length = 0;
            for (const row of rows) {
              const item = normalizeLibraryRow(row);
              if (item) collected.push(item);
            }
            rpcSuccess = true;
          }
        }
      } catch (err) {
        console.warn("[nuvio-library] table query fallback failed", err);
      }
    }

    // If both failed, do NOT wipe local cache
    if (!rpcSuccess && collected.length === 0) {
      return readCachedNuvioLibrary(slot);
    }

    // Prune any items that were deleted locally (tombstones or pendingDeletes)
    const tombstones = readTombstones(slot);
    const pendingDeletes = readPendingDeletes(slot);
    const pendingIds = new Set(pendingDeletes.map((k) => k.content_id));

    // Preserve any pending local upserts that haven't reached the server yet
    const pendingUpserts = readPendingUpserts(slot);
    const pendingUpsertMap = new Map<string, NuvioLibraryItem>();
    for (const u of pendingUpserts) {
      if (u && u.content_id) {
        pendingUpsertMap.set(`${u.content_type}:${u.content_id}`, u);
      }
    }

    const seenKeys = new Set<string>();
    const sanitized: NuvioLibraryItem[] = [];

    // Pending upserts take priority at the top
    for (const u of pendingUpserts) {
      const key = `${u.content_type}:${u.content_id}`;
      if (!tombstones.has(u.content_id) && !pendingIds.has(u.content_id)) {
        sanitized.push(u);
        seenKeys.add(key);
      }
    }

    for (const item of collected) {
      const key = `${item.content_type}:${item.content_id}`;
      if (
        !seenKeys.has(key) &&
        !tombstones.has(item.content_id) &&
        !tombstones.has(key) &&
        !pendingIds.has(item.content_id)
      ) {
        sanitized.push(item);
        seenKeys.add(key);
      }
    }

    // Update local cache & notify subscribers if data changed
    setCachedNuvioLibraryIfChanged(slot, sanitized);
    if (cursor > 0) writeNuvioCursor(slot, cursor);

    return sanitized;
  } catch (err) {
    console.error("[nuvio-library] snapshot pull error", err);
    return readCachedNuvioLibrary(slot);
  }
}

/**
 * Pulls incremental deltas since last cursor via sync_pull_library_delta RPC.
 * Respects local tombstones and pending deletes.
 */
export async function pullNuvioLibraryDelta(
  slot: number,
): Promise<NuvioLibraryItem[]> {
  const currentCursor = readNuvioCursor(slot);
  if (currentCursor == null) {
    return pullNuvioLibrarySnapshot(slot);
  }

  if (!isNuvioSignedIn()) return readCachedNuvioLibrary(slot);

  try {
    const res = await nuvioFetch("/rest/v1/rpc/sync_pull_library_delta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        p_profile_id: slot,
        p_since_event_id: currentCursor,
        p_limit: 100,
      }),
    });

    if (!res.ok) {
      // If delta RPC not supported or cursor invalid, fallback cleanly to snapshot
      return pullNuvioLibrarySnapshot(slot);
    }

    const deltas = (await res.json()) as unknown;
    if (!Array.isArray(deltas) || deltas.length === 0) {
      return readCachedNuvioLibrary(slot);
    }

    const tombstones = readTombstones(slot);
    const pendingDeletes = readPendingDeletes(slot);
    const pendingIds = new Set(pendingDeletes.map((k) => k.content_id));

    const cached = readCachedNuvioLibrary(slot);
    const itemMap = new Map<string, NuvioLibraryItem>();
    for (const item of cached) {
      if (
        !tombstones.has(item.content_id) &&
        !tombstones.has(`${item.content_type}:${item.content_id}`) &&
        !pendingIds.has(item.content_id)
      ) {
        itemMap.set(`${item.content_type}:${item.content_id}`, item);
      }
    }

    let latestEventId = currentCursor;

    for (const d of deltas) {
      const delta = d as NuvioLibraryDeltaItem;
      if (!delta || !delta.content_id) continue;
      const key = `${delta.content_type || "movie"}:${delta.content_id}`;
      if (typeof delta.event_id === "number" && delta.event_id > latestEventId) {
        latestEventId = delta.event_id;
      }

      if (
        delta.operation === "DELETE" ||
        tombstones.has(delta.content_id) ||
        tombstones.has(key) ||
        pendingIds.has(delta.content_id)
      ) {
        itemMap.delete(key);
      } else {
        itemMap.set(key, {
          content_id: delta.content_id,
          content_type: delta.content_type || "movie",
          name: delta.name || "",
          poster: delta.poster || null,
          poster_shape: delta.poster_shape || "POSTER",
          background: delta.background || null,
          logo: delta.logo || null,
          description: delta.description || null,
          release_info: delta.release_info || null,
          imdb_rating: typeof delta.imdb_rating === "number" ? delta.imdb_rating : null,
          genres: Array.isArray(delta.genres) ? delta.genres : [],
          addon_base_url: delta.addon_base_url || null,
          added_at: delta.added_at || Date.now(),
        });
      }
    }

    const updated = Array.from(itemMap.values());
    setCachedNuvioLibraryIfChanged(slot, updated);
    writeNuvioCursor(slot, latestEventId);
    return updated;
  } catch (e) {
    console.warn("[nuvio-library] delta sync error, falling back to cache", e);
    return readCachedNuvioLibrary(slot);
  }
}

// Debounce timer for pushing mutations
const debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Immediately pushes any pending deletes and upserts to Nuvio Cloud for the specified slot.
 * Retries with fallback payloads and table endpoints if RPCs fail.
 */
export async function flushNuvioLibraryMutations(slot: number): Promise<boolean> {
  const existing = debounceTimers.get(slot);
  if (existing) {
    clearTimeout(existing);
    debounceTimers.delete(slot);
  }
  if (!isNuvioSignedIn()) return false;

  let success = true;
  const clientId = getOrCreateSyncClientId();

  // 1. Process deletes: try sync_delete_library_items RPC first, then direct table delete
  const pendingDeletes = readPendingDeletes(slot);
  const validDeletes = pendingDeletes.filter(
    (k) => k && k.content_id && String(k.content_id).trim().length > 0,
  );

  if (validDeletes.length > 0) {
    try {
      let delOk = false;

      // Method A: Official sync_delete_library_items RPC
      try {
        const rpcRes = await nuvioFetch("/rest/v1/rpc/sync_delete_library_items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            p_profile_id: slot,
            p_keys: validDeletes.map((k) => ({
              content_id: k.content_id.trim(),
              content_type: k.content_type || "movie",
            })),
            p_origin_client_id: clientId,
          }),
        });
        if (rpcRes.ok) delOk = true;
      } catch {}

      // Method B: Direct table delete (always executed to ensure DB row is removed)
      for (const item of validDeletes) {
        try {
          await nuvioFetch(
            `/rest/v1/library_items?profile_id=eq.${slot}&content_id=eq.${encodeURIComponent(item.content_id.trim())}`,
            { method: "DELETE" },
          );
          delOk = true;
        } catch {}
      }

      if (delOk) {
        writePendingDeletes(slot, []);
      }
    } catch (err) {
      console.warn("[nuvio-library] push deletes failed", err);
      success = false;
    }
  }

  // 2. Process upserts: try sync_push_library_items RPC, sync_push_library RPC, then direct table upsert
  const pendingUpserts = readPendingUpserts(slot);
  const validUpserts = pendingUpserts.filter(
    (item) => item && item.content_id && String(item.content_id).trim().length > 0,
  );

  if (validUpserts.length > 0) {
    try {
      let upOk = false;
      const sanitized = validUpserts.map((item) => ({
        content_id: item.content_id.trim(),
        content_type: item.content_type || "movie",
        name: item.name || "",
        poster: item.poster || null,
        poster_shape: item.poster_shape || "POSTER",
        background: item.background || null,
        logo: item.logo || null,
        description: item.description || null,
        release_info: item.release_info || null,
        imdb_rating: typeof item.imdb_rating === "number" ? item.imdb_rating : null,
        genres: Array.isArray(item.genres) ? item.genres : [],
        addon_base_url: item.addon_base_url || null,
        added_at: item.added_at || Date.now(),
      }));

      // Try 1: sync_push_library_items RPC (matching Nuvio Mobile)
      try {
        const res = await nuvioFetch("/rest/v1/rpc/sync_push_library_items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            p_profile_id: slot,
            p_items: sanitized,
            p_origin_client_id: clientId,
          }),
        });
        if (res.ok) upOk = true;
      } catch {}

      // Try 2: sync_push_library RPC
      if (!upOk) {
        try {
          const res = await nuvioFetch("/rest/v1/rpc/sync_push_library", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              p_profile_id: slot,
              p_items: sanitized,
              p_origin_client_id: clientId,
            }),
          });
          if (res.ok) upOk = true;
        } catch {}
      }

      // Try 3: Direct table upsert fallback
      if (!upOk) {
        try {
          const tableRows = sanitized.map((item) => ({
            profile_id: slot,
            ...item,
          }));
          const tableRes = await nuvioFetch("/rest/v1/library_items", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Prefer: "resolution=merge-duplicates",
            },
            body: JSON.stringify(tableRows),
          });
          if (tableRes.ok) upOk = true;
        } catch {}
      }

      if (upOk) {
        writePendingUpserts(slot, []);
      }
    } catch (err) {
      console.warn("[nuvio-library] push upserts failed", err);
      success = false;
    }
  }

  return success;
}

/**
 * Schedules a background sync of pending mutations to Supabase (200ms debounce).
 */
function scheduleMutationPush(slot: number): void {
  const existing = debounceTimers.get(slot);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(slot);
    void flushNuvioLibraryMutations(slot);
  }, 200);

  debounceTimers.set(slot, timer);
}

/**
 * Adds an item to the Nuvio library for a profile slot, updating local cache
 * immediately and queueing a cloud push.
 */
export function addNuvioLibraryItem(
  slot: number,
  item: NuvioLibraryItem,
): void {
  if (!item || !item.content_id || !item.content_id.trim()) return;
  const cleanId = item.content_id.trim();
  const cleanItem = { ...item, content_id: cleanId };

  clearTombstone(slot, cleanId);

  const items = readCachedNuvioLibrary(slot);
  const filtered = items.filter(
    (i) => !(i.content_id === cleanId && i.content_type === cleanItem.content_type),
  );
  filtered.unshift(cleanItem);
  writeCachedNuvioLibrary(slot, filtered, true);

  // Queue for cloud push
  const pendingUpserts = readPendingUpserts(slot);
  const nextUpserts = pendingUpserts.filter(
    (i) => !(i.content_id === cleanId && i.content_type === cleanItem.content_type),
  );
  nextUpserts.push(cleanItem);
  writePendingUpserts(slot, nextUpserts);

  // Remove from pending deletes if present
  const pendingDeletes = readPendingDeletes(slot).filter(
    (k) => !(k.content_id === cleanId && k.content_type === cleanItem.content_type),
  );
  writePendingDeletes(slot, pendingDeletes);

  scheduleMutationPush(slot);
}

/**
 * Removes an item from the Nuvio library for a profile slot, updating local cache
 * immediately, recording a tombstone to prevent resurrection, and queueing a cloud delete.
 */
export function removeNuvioLibraryItem(
  slot: number,
  contentId: string,
  contentType?: string,
): void {
  if (!contentId || typeof contentId !== "string" || !contentId.trim()) return;
  const cleanId = contentId.trim();
  const type = (contentType || "movie").trim();

  recordTombstone(slot, cleanId, type);

  const items = readCachedNuvioLibrary(slot);
  const updated = items.filter((i) => i.content_id !== cleanId);
  writeCachedNuvioLibrary(slot, updated, true);

  // Remove from pending upserts
  const pendingUpserts = readPendingUpserts(slot).filter(
    (i) => i.content_id !== cleanId,
  );
  writePendingUpserts(slot, pendingUpserts);

  // Add to pending deletes
  const pendingDeletes = readPendingDeletes(slot).filter(
    (k) => k.content_id !== cleanId,
  );
  pendingDeletes.push({ content_id: cleanId, content_type: type });
  writePendingDeletes(slot, pendingDeletes);

  scheduleMutationPush(slot);
}

/**
 * Checks if an item is bookmarked in the active Nuvio profile's library.
 */
export function isNuvioItemInLibrary(
  slot: number,
  contentId: string,
  altIds?: string[],
): boolean {
  if (!contentId) return false;
  const cleanId = contentId.trim();
  const items = readCachedNuvioLibrary(slot);
  const candidates = [cleanId, ...(altIds || []).filter(Boolean).map((a) => a.trim())];
  return items.some((item) => candidates.includes(item.content_id));
}

export const saveNuvioLibraryItem = addNuvioLibraryItem;
