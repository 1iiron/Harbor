import type { ExternalCwSource } from "@/lib/stremio";
import { privateCwProfileId } from "./cw-profile";

const KEY = "harbor.resume";
const PRIVATE_PREFIX = "harbor.resume.private.v1.";

function readKey(): string {
  const profileId = privateCwProfileId();
  return profileId ? PRIVATE_PREFIX + profileId : KEY;
}

type Entry = { ms: number; t: number; s?: number; pct?: number; source?: ExternalCwSource };

function entryKey(id: string, season?: number, episode?: number): string {
  if (typeof season === "number" && typeof episode === "number") {
    return `${id}|s${season}e${episode}`;
  }
  return id;
}

const parsedResume = new Map<string, { raw: string | null; entries: Record<string, Entry> }>();

function readAll(key = readKey()): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(key);
    const cached = parsedResume.get(key);
    if (cached && cached.raw === raw) return cached.entries;
    const entries = raw ? (JSON.parse(raw) as Record<string, Entry>) : {};
    parsedResume.set(key, { raw, entries });
    return entries;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Entry>, key: string, acknowledged = false): void {
  try {
    const raw = JSON.stringify(all);
    localStorage.setItem(key, raw);
    parsedResume.set(key, { raw, entries: all });
  } catch (error) {
    parsedResume.delete(key);
    if (acknowledged) throw error;
  }
}

export function saveResumeMs(
  id: string,
  ms: number,
  season?: number,
  episode?: number,
  displaySeason?: number,
  pct?: number,
  source?: ExternalCwSource,
  ownerId?: string,
): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  if (typeof season === "number" && typeof episode === "number") {
    if (season < 0 || episode < 1) return;
  }
  const s = typeof displaySeason === "number" && displaySeason >= 1 ? displaySeason : undefined;
  const p = pct !== undefined && Number.isFinite(pct) && pct >= 0 && pct <= 1 ? pct : undefined;
  const entry: Entry = {
    ms,
    t: Date.now(),
    ...(s !== undefined ? { s } : {}),
    ...(p !== undefined ? { pct: p } : {}),
    ...(source !== undefined ? { source } : {}),
  };
  const targetOwner = ownerId ?? privateCwProfileId();
  const isNuvio = Boolean(targetOwner?.startsWith("nuvio-"));
  const targetKeys = isNuvio
    ? [PRIVATE_PREFIX + targetOwner]
    : targetOwner
      ? [KEY, PRIVATE_PREFIX + targetOwner]
      : [KEY];
  for (const key of targetKeys) {
    const all = readAll(key);
    all[entryKey(id, season, episode)] = entry;
    writeAll(all, key);
  }
}

export function saveResumeBatch(
  entries: {
    id: string;
    ms: number;
    season?: number;
    episode?: number;
    t?: number;
    pct?: number;
    source?: ExternalCwSource;
  }[],
): void {
  if (entries.length === 0) return;
  const targetOwner = privateCwProfileId();
  const isNuvio = Boolean(targetOwner?.startsWith("nuvio-"));
  const keys = isNuvio
    ? [PRIVATE_PREFIX + targetOwner]
    : targetOwner
      ? [KEY, PRIVATE_PREFIX + targetOwner]
      : [KEY];
  const now = Date.now();
  for (const key of keys) {
    const all = readAll(key);
    for (const e of entries) {
      if (!Number.isFinite(e.ms) || e.ms < 0) continue;
      if (typeof e.season === "number" && typeof e.episode === "number") {
        if (e.season < 0 || e.episode < 1) continue;
      }
      const p =
        e.pct !== undefined && Number.isFinite(e.pct) && e.pct >= 0 && e.pct <= 1 ? e.pct : undefined;
      all[entryKey(e.id, e.season, e.episode)] = {
        ms: e.ms,
        t: e.t ?? now,
        ...(p !== undefined ? { pct: p } : {}),
        ...(e.source !== undefined ? { source: e.source } : {}),
      };
    }
    writeAll(all, key);
  }
}

export function readResumeMs(id: string, season?: number, episode?: number): number {
  const all = readAll();
  return all[entryKey(id, season, episode)]?.ms ?? 0;
}

export function readResumeEntry(
  id: string,
  season?: number,
  episode?: number,
): { ms: number; t: number; s?: number; pct?: number; source?: ExternalCwSource } | null {
  const k = entryKey(id, season, episode);
  const currentKey = readKey();
  const all = readAll(currentKey);
  const e = all[k];
  if (e) {
    return {
      ms: e.ms,
      t: e.t,
      ...(e.s !== undefined ? { s: e.s } : {}),
      ...(e.pct !== undefined ? { pct: e.pct } : {}),
      ...(e.source !== undefined ? { source: e.source } : {}),
    };
  }
  if (currentKey !== KEY && !currentKey.includes("nuvio-")) {
    const globalAll = readAll(KEY);
    const ge = globalAll[k];
    if (ge) {
      return {
        ms: ge.ms,
        t: ge.t,
        ...(ge.s !== undefined ? { s: ge.s } : {}),
        ...(ge.pct !== undefined ? { pct: ge.pct } : {}),
        ...(ge.source !== undefined ? { source: ge.source } : {}),
      };
    }
  }
  return null;
}

export function readResumeSource(
  id: string,
  season?: number,
  episode?: number,
): ExternalCwSource | undefined {
  return readAll()[entryKey(id, season, episode)]?.source;
}

export function clearResume(
  id: string,
  season?: number,
  episode?: number,
  ownerOrOptions?: string | { acknowledged?: boolean; ownerId?: string },
): void {
  const ownerId = typeof ownerOrOptions === "string" ? ownerOrOptions : ownerOrOptions?.ownerId;
  const acknowledged = typeof ownerOrOptions === "object" && ownerOrOptions?.acknowledged === true;
  const targetOwner = ownerId ?? privateCwProfileId();
  const isNuvio = Boolean(targetOwner?.startsWith("nuvio-"));
  const targetKeys = isNuvio
    ? [PRIVATE_PREFIX + targetOwner, KEY]
    : targetOwner
      ? [KEY, PRIVATE_PREFIX + targetOwner]
      : [KEY];
  for (const key of targetKeys) {
    const all = readAll(key);
    if (typeof season === "number" && typeof episode === "number") {
      delete all[entryKey(id, season, episode)];
    } else {
      delete all[id];
      const prefix = `${id}|`;
      for (const k of Object.keys(all)) {
        if (k.startsWith(prefix)) delete all[k];
      }
    }
    writeAll(all, key, acknowledged);
  }
}

export function lastPlayedEpisode(seriesId: string): {
  season: number;
  episode: number;
  ms: number;
  t: number;
  displaySeason?: number;
  pct?: number;
  source?: ExternalCwSource;
} | null {
  const all = readAll();
  const prefix = `${seriesId}|s`;
  let best: {
    season: number;
    episode: number;
    ms: number;
    t: number;
    displaySeason?: number;
    pct?: number;
    source?: ExternalCwSource;
  } | null = null;
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(prefix)) continue;
    const m = key.match(/\|s(\d+)e(\d+)$/);
    if (!m) continue;
    const season = parseInt(m[1], 10);
    const episode = parseInt(m[2], 10);
    if (season < 1 || episode < 1) continue;
    if (!best || value.t > best.t) {
      best = {
        season,
        episode,
        ms: value.ms,
        t: value.t,
        displaySeason: value.s,
        pct: value.pct,
        source: value.source,
      };
    }
  }
  return best;
}
