import { readSharedSecret, writeSharedSecret } from "@/lib/secret-store";
import { clearPendingWatches } from "./pending-sync";
import type { SimklSession } from "./types";

const BASE_KEY = "harbor.simkl.session.v1";

const subscribers = new Set<() => void>();
let cached: SimklSession | null = null;
let loaded = false;

function read(): SimklSession | null {
  try {
    const raw = readSharedSecret(BASE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SimklSession;
    if (typeof parsed?.accessToken !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function write(session: SimklSession | null): void {
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

export function getSession(): SimklSession | null {
  ensureLoaded();
  return cached;
}

export function setSession(session: SimklSession | null): void {
  ensureLoaded();
  if (!session || !cached || session.username !== cached.username) {
    clearPendingWatches();
  }
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
  return !!getSession();
}
