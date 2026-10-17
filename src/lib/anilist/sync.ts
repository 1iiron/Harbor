import { activeProfileId } from "@/lib/active-profile-id";
import { kitsuToAnilist } from "@/lib/providers/anime-mapping";
import { AnilistApiError, anilistRequest } from "./client";
import { isAuthenticated, getSession } from "./session";

export type SyncError = "update-not-confirmed" | "unreachable";

export type SyncEvent =
  | { kind: "syncing"; title: string; episode: number; rewatch?: boolean }
  | { kind: "ok"; title: string; episode: number; rewatch?: boolean }
  | { kind: "watching"; title: string }
  | { kind: "error"; title: string; error: SyncError };

const listeners = new Set<(e: SyncEvent) => void>();
let last: SyncEvent | null = null;

export function subscribeSync(fn: (e: SyncEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getLastSync(): SyncEvent | null {
  return last;
}

function emit(e: SyncEvent): void {
  last = e;
  for (const fn of listeners) fn(e);
}

const SENT_KEY_BASE = "harbor.anilist.synced.v1";
function sentKey(): string {
  return `${SENT_KEY_BASE}.${activeProfileId()}`;
}
type SentValue = number | { p: number; t: number };
type SentMap = Record<string, SentValue>;

// Only collapses the per-tick writes of one playback session. Kept indefinitely it
// outlives the server, so removing the entry there could never be re-synced.
const SENT_TTL_MS = 60 * 1000;

function sentProgress(map: SentMap, key: string): { p: number; t: number } | null {
  const value = map[key];
  if (typeof value === "number") return { p: value, t: 0 };
  if (value && typeof value === "object" && typeof value.p === "number") {
    return { p: value.p, t: typeof value.t === "number" ? value.t : 0 };
  }
  return null;
}

function rememberSent(map: SentMap, key: string, progress: number): void {
  map[key] = { p: progress, t: Date.now() };
}

function loadSent(): SentMap {
  try {
    return JSON.parse(localStorage.getItem(sentKey()) ?? "{}") as SentMap;
  } catch {
    return {};
  }
}

function saveSent(map: SentMap): void {
  try {
    localStorage.setItem(sentKey(), JSON.stringify(map));
  } catch {
    return;
  }
}

// Titles that have ever been Completed/Rewatching. The `sent` map is keyed by
// episode, so it cannot tell a first watch from a rewatch — once a title is known
// to be finished, the per-episode fast-path steps aside so a second pass over an
// already-pinned episode is not skipped forever. Bounded by the number of finished
// titles, and re-read per call, so it survives profile switches and reloads.
const REWATCH_KEY_BASE = "harbor.anilist.rewatch.v1";
function rewatchKey(): string {
  return `${REWATCH_KEY_BASE}.${activeProfileId()}`;
}
type RewatchMap = Record<string, true>;

function loadRewatch(): RewatchMap {
  try {
    return JSON.parse(localStorage.getItem(rewatchKey()) ?? "{}") as RewatchMap;
  } catch {
    return {};
  }
}

function saveRewatch(map: RewatchMap): void {
  try {
    localStorage.setItem(rewatchKey(), JSON.stringify(map));
  } catch {
    return;
  }
}

function leadingInt(value: string): number | null {
  const n = Number(value.split(":")[0]);
  return Number.isFinite(n) ? n : null;
}

const MAL_QUERY = `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { id } }`;

async function malToAnilist(idMal: number): Promise<number | null> {
  try {
    const data = await anilistRequest<{ Media: { id: number } | null }>(MAL_QUERY, { idMal });
    return data?.Media?.id ?? null;
  } catch {
    return null;
  }
}

export async function resolveAnilistMediaId(harborId: string): Promise<number | null> {
  if (harborId.startsWith("anilist:")) return leadingInt(harborId.slice(8));
  if (harborId.startsWith("kitsu:")) {
    const k = leadingInt(harborId.slice(6));
    return k != null ? kitsuToAnilist(k) : null;
  }
  if (harborId.startsWith("mal:")) {
    const m = leadingInt(harborId.slice(4));
    return m != null ? malToAnilist(m) : null;
  }
  return null;
}

const ENTRY_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    episodes
    mediaListEntry { id progress status repeat }
  }
}`;

const SAVE_MUTATION = `mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
    id
    progress
    status
  }
}`;

// Finishing a rewatch: AniList counts it by flipping the entry to Completed and
// bumping `repeat`. The counter is a plain input field, so it has to be sent —
// a bare status change does not increment it.
const SAVE_REWATCH_DONE_MUTATION = `mutation ($mediaId: Int, $progress: Int, $repeat: Int) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: COMPLETED, repeat: $repeat) {
    id
    progress
    status
    repeat
  }
}`;

const SAVE_STATUS_MUTATION = `mutation ($mediaId: Int, $status: MediaListStatus) {
  SaveMediaListEntry(mediaId: $mediaId, status: $status) {
    id
    status
  }
}`;

type EntryResponse = {
  Media: {
    id: number;
    episodes: number | null;
    mediaListEntry: { id: number; progress: number; status: string; repeat: number } | null;
  } | null;
};

type SaveResponse = {
  SaveMediaListEntry: { id: number; progress: number; status: string } | null;
};

type RewatchDoneResponse = {
  SaveMediaListEntry: { id: number; progress: number; status: string; repeat: number } | null;
};

const inflight = new Set<string>();
const watchingMarked = new Set<string>();
// A rewatch we just finished keeps its finale emitting progress events; without
// this the next tick would read COMPLETED and start the rewatch all over again.
const rewatchCompleted = new Map<string, number>();

export function resetForProfile(): void {
  inflight.clear();
  watchingMarked.clear();
  rewatchCompleted.clear();
}

export async function markAnimeWatching(harborId: string, title: string): Promise<void> {
  if (!isAuthenticated()) return;
  const profile = activeProfileId();
  const session = getSession();
  const owned = () => activeProfileId() === profile && getSession() === session;
  if (watchingMarked.has(harborId)) return;
  watchingMarked.add(harborId);
  try {
    const mediaId = await resolveAnilistMediaId(harborId);
    if (!owned() || mediaId == null) {
      watchingMarked.delete(harborId);
      return;
    }
    const cur = await anilistRequest<EntryResponse>(ENTRY_QUERY, { id: mediaId });
    if (!owned()) return;
    const entry = cur?.Media?.mediaListEntry;
    if (entry && entry.status !== "PLANNING") return;
    const total = cur?.Media?.episodes ?? 0;
    if (entry && total > 0 && entry.progress >= total) return;
    await anilistRequest<{ SaveMediaListEntry: { id: number } | null }>(SAVE_STATUS_MUTATION, {
      mediaId,
      status: "CURRENT",
    });
    if (owned()) emit({ kind: "watching", title });
  } catch (e) {
    watchingMarked.delete(harborId);
    if (e instanceof AnilistApiError && e.status === 401) return;
  }
}

export async function syncAnimeProgress(
  harborId: string,
  episode: number | undefined,
  title: string,
  season?: number,
  countRewatches = true,
): Promise<void> {
  if (!isAuthenticated()) return;
  const profile = activeProfileId();
  const session = getSession();
  const owned = () => activeProfileId() === profile && getSession() === session;
  const ep = episode ?? 1;
  if (!Number.isInteger(ep) || ep < 1) return;

  const sent = loadSent();
  const sentKey = `${harborId}|${season ?? ""}|${ep}`;
  const rewatch = loadRewatch();
  const prevSent = sentProgress(sent, sentKey);
  // Finished/repeating titles skip the per-episode fast-path (see RewatchMap).
  if (
    rewatch[harborId] !== true &&
    prevSent &&
    Date.now() - prevSent.t < SENT_TTL_MS &&
    prevSent.p >= ep
  ) {
    return;
  }

  const flightKey = `${profile}|${harborId}|${ep}`;
  if (inflight.has(flightKey)) {
    return;
  }
  inflight.add(flightKey);

  try {
    const mediaId = await resolveAnilistMediaId(harborId);
    if (!owned() || mediaId == null) return;

    const cur = await anilistRequest<EntryResponse>(ENTRY_QUERY, { id: mediaId });
    if (!owned()) return;
    const media = cur?.Media;
    if (!media) return;

    const entryStatus = media.mediaListEntry?.status;
    const current = media.mediaListEntry?.progress ?? 0;
    const total = media.episodes ?? 0;

    // The user already finished (or is rewatching) this title. A plain watched
    // push would send CURRENT and reset the entry's progress — AniList sets
    // progress to whatever it is sent, lower numbers included — so keep the entry
    // on REPEATING and only ever move the rewatch counter forward. That is what
    // renders the episodes as Rewatched rather than Watched.
    if (entryStatus === "COMPLETED" || entryStatus === "REPEATING") {
      // Rewatch recording is off: leave the finished entry exactly as the user
      // set it, the way the sync behaved before rewatches were supported.
      if (!countRewatches) return;
      // Remember the title as finished: the sent fast-path above is keyed by
      // episode and cannot tell a first watch from a rewatch, so it steps aside.
      if (rewatch[harborId] !== true) {
        rewatch[harborId] = true;
        saveRewatch(rewatch);
      }
      // The caller resolves entry-relative numbering before reaching this layer.
      const target = ep;
      if (total > 0 && target > total) return;
      // The finale of a rewatch we just finished keeps emitting progress; without
      // this the next tick would read COMPLETED and start the rewatch over.
      const completedEp = rewatchCompleted.get(harborId);
      if (completedEp != null && entryStatus === "COMPLETED" && ep >= completedEp) return;

      // Watching the finale while already Rewatching finishes the pass: AniList
      // counts a finished rewatch as Completed with `repeat` bumped.
      if (entryStatus === "REPEATING" && total > 0 && target >= total) {
        const repeat = (media.mediaListEntry?.repeat ?? 0) + 1;
        emit({ kind: "syncing", title, episode: total, rewatch: true });
        const saved = await anilistRequest<RewatchDoneResponse>(SAVE_REWATCH_DONE_MUTATION, {
          mediaId,
          progress: total,
          repeat,
        });
        if (saved?.SaveMediaListEntry?.progress === total) {
          rewatchCompleted.set(harborId, ep);
          emit({ kind: "ok", title, episode: total, rewatch: true });
        } else {
          emit({ kind: "error", title, error: "update-not-confirmed" });
        }
        return;
      }

      // Starting a rewatch ignores the completed progress (AniList resets the
      // rewatch counter); continuing one is forward-only, where equal is not
      // backwards. A new pass clears the finished-rewatch guard above.
      if (entryStatus === "REPEATING" && target <= current) return;
      rewatchCompleted.delete(harborId);
      emit({ kind: "syncing", title, episode: target, rewatch: true });
      const saved = await anilistRequest<SaveResponse>(SAVE_MUTATION, {
        mediaId,
        progress: target,
        status: "REPEATING",
      });
      if (saved?.SaveMediaListEntry?.progress === target) {
        emit({ kind: "ok", title, episode: target, rewatch: true });
      } else {
        emit({ kind: "error", title, error: "update-not-confirmed" });
      }
      return;
    }

    // The caller resolves entry-relative numbering before reaching this layer.
    const target = ep;
    if (total > 0 && target > total) return;
    if (target <= current) {
      rememberSent(sent, sentKey, Math.max(prevSent?.p ?? 0, current));
      saveSent(sent);
      return;
    }

    const status = total > 0 && target >= total ? "COMPLETED" : "CURRENT";
    // Mark the title finished so a later rewatch is not swallowed by this
    // episode's first-watch entry in the fast-path above.
    if (status === "COMPLETED") {
      rewatch[harborId] = true;
      saveRewatch(rewatch);
    }
    emit({ kind: "syncing", title, episode: target });

    const saved = await anilistRequest<SaveResponse>(SAVE_MUTATION, {
      mediaId,
      progress: target,
      status,
    });

    if (!owned()) return;
    if (saved?.SaveMediaListEntry?.progress === target) {
      rememberSent(sent, sentKey, target);
      saveSent(sent);
      // A first-watch completion is not a finished rewatch: remember where it
      // happened so the finale's trailing progress ticks read COMPLETED and stop
      // instead of flipping the entry into a phantom rewatch.
      if (status === "COMPLETED") rewatchCompleted.set(harborId, target);
      emit({ kind: "ok", title, episode: target });
    } else {
      // Unconfirmed writes stay retryable; recording them as sent would suppress retries.
      emit({ kind: "error", title, error: "update-not-confirmed" });
    }
  } catch (e) {
    if (!owned()) return;
    if (e instanceof AnilistApiError && e.status === 401) return;
    emit({ kind: "error", title, error: "unreachable" });
  } finally {
    inflight.delete(flightKey);
  }
}
