import { readSharedSecret, writeSharedSecret } from "@/lib/secret-store";
import type { AnilistSession } from "./types";

const BASE_KEY = "harbor.anilist.session.v1";

const subscribers = new Set<() => void>();
let cached: AnilistSession | null = null;
let loaded = false;

function read(): AnilistSession | null {
  try {
    const raw = readSharedSecret(BASE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AnilistSession;
    if (
      typeof parsed?.accessToken !== "string" ||
      typeof parsed?.createdAt !== "number" ||
      typeof parsed?.expiresAt !== "number" ||
      typeof parsed?.userId !== "number" ||
      typeof parsed?.userName !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function write(session: AnilistSession | null): void {
  try {
    writeSharedSecret(BASE_KEY, session ? JSON.stringify(session) : null);
  } catch {
    return;
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  cached = read();
}

export function resetForProfile(): void {
  loaded = false;
  cached = null;
  for (const fn of subscribers) fn();
}

export function getSession(): AnilistSession | null {
  ensureLoaded();
  return cached;
}

export function setSession(session: AnilistSession | null): void {
  ensureLoaded();
  cached = session;
  write(session);
  for (const fn of subscribers) fn();
}

export function subscribeSession(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function isAuthenticated(): boolean {
  const s = getSession();
  if (!s) return false;
  return Date.now() < s.expiresAt;
}
