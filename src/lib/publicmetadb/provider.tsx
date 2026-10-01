import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { verifyApiKey } from "./client";
import { markPmdbWatched, unmarkPmdbWatched } from "./history";
import { stremioIdToPmdbTarget } from "./ids";
import { getSession, setSession, subscribeSession, updateSessionUsername } from "./session";
import type { PmdbSession, PmdbTarget } from "./types";

type Value = {
  session: PmdbSession | null;
  isConnected: boolean;
  username: string | null;
  connect: (apiKey: string, username?: string) => Promise<boolean>;
  updateUsername: (username: string) => void;
  disconnect: () => void;
  markWatched: (
    metaId: string,
    episode?: { season: number; episode: number },
    type?: "movie" | "series",
  ) => Promise<boolean>;
  unmarkWatched: (
    metaId: string,
    episode?: { season: number; episode: number },
    type?: "movie" | "series",
  ) => Promise<boolean>;
  resolveTarget: (
    metaId: string,
    episode?: { season: number; episode: number },
    type?: "movie" | "series",
  ) => PmdbTarget | null;
};

const Ctx = createContext<Value | null>(null);

export function PublicMetaDbProvider({ children }: { children: ReactNode }) {
  const [session, setLocalSession] = useState<PmdbSession | null>(() => getSession());

  useEffect(
    () =>
      subscribeSession(() => {
        setLocalSession(getSession());
      }),
    [],
  );

  const connect = useCallback(async (apiKey: string, username?: string): Promise<boolean> => {
    const trimmed = apiKey.trim();
    if (!trimmed) return false;
    const ok = await verifyApiKey(trimmed);
    if (!ok) return false;

    setSession({
      apiKey: trimmed,
      username: username?.trim() || undefined,
      validatedAt: Date.now(),
    });
    return true;
  }, []);

  const updateUsername = useCallback((username: string) => {
    updateSessionUsername(username);
  }, []);

  const disconnect = useCallback(() => {
    setSession(null);
  }, []);

  const resolveTarget = useCallback(
    (
      metaId: string,
      episode?: { season: number; episode: number },
      type?: "movie" | "series",
    ): PmdbTarget | null => {
      return stremioIdToPmdbTarget(metaId, episode, type);
    },
    [],
  );

  const markWatched = useCallback(
    async (
      metaId: string,
      episode?: { season: number; episode: number },
      type?: "movie" | "series",
    ): Promise<boolean> => {
      const target = resolveTarget(metaId, episode, type);
      if (!target) return false;
      return markPmdbWatched(target);
    },
    [resolveTarget],
  );

  const unmarkWatched = useCallback(
    async (
      metaId: string,
      episode?: { season: number; episode: number },
      type?: "movie" | "series",
    ): Promise<boolean> => {
      const target = resolveTarget(metaId, episode, type);
      if (!target) return false;
      return unmarkPmdbWatched(target);
    },
    [resolveTarget],
  );

  const value = useMemo<Value>(
    () => ({
      session,
      isConnected: !!session?.apiKey,
      username: session?.username ?? null,
      connect,
      updateUsername,
      disconnect,
      markWatched,
      unmarkWatched,
      resolveTarget,
    }),
    [session, connect, updateUsername, disconnect, markWatched, unmarkWatched, resolveTarget],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePublicMetaDb(): Value {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePublicMetaDb outside PublicMetaDbProvider");
  return v;
}
