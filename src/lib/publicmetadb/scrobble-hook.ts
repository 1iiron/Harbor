import { useEffect, useRef } from "react";
import { getPlaybackPosition } from "@/lib/player/playback-clock";
import { useSettings } from "@/lib/settings";
import type { PlayerSrc } from "@/lib/view";
import { resolvePmdbEpisodeTarget, stremioIdToPmdbTarget } from "./ids";
import { usePublicMetaDb } from "./provider";
import { pmdbBeaconResume, pmdbSaveResume } from "./scrobble";
import { markPmdbWatched } from "./history";
import type { PmdbTarget } from "./types";

type Snap = {
  status: string;
  positionSec: number;
  durationSec: number;
};

const STUB_MAX_SEC = 120;
const COMPLETION_RATIO = 0.8;
const MIN_SAVE_INTERVAL_MS = 30_000;

export function usePublicMetaDbScrobble({ src, snap }: { src: PlayerSrc; snap: Snap }): void {
  const { isConnected } = usePublicMetaDb();
  const { settings } = useSettings();
  const enabled = isConnected && settings.publicmetadbScrobbleEnabled;

  const targetRef = useRef<PmdbTarget | null>(null);
  const lastSaveTimeRef = useRef(0);
  const lastSavedPosRef = useRef(-1);
  const endedHandledRef = useRef(false);

  const metaId = src.meta.id;
  const season = src.episode?.season;
  const episode = src.episode?.episode;
  const key = `${metaId}|${season ?? ""}|${episode ?? ""}`;
  const lastKeyRef = useRef<string | null>(null);

  // Resolve target whenever media identity changes
  useEffect(() => {
    let cancelled = false;
    targetRef.current = null;
    endedHandledRef.current = false;
    lastSaveTimeRef.current = 0;
    lastSavedPosRef.current = -1;

    void (async () => {
      let resolved: PmdbTarget | null = null;
      if (src.episode) {
        resolved = await resolvePmdbEpisodeTarget(
          metaId,
          { season: src.episode.season, episode: src.episode.episode },
          src.imdbId,
        );
      } else {
        const type = src.meta.type === "series" ? "series" : "movie";
        resolved = stremioIdToPmdbTarget(metaId, undefined, type);
        if (!resolved && src.imdbId) {
          resolved = {
            id_type: "imdb",
            id_value: src.imdbId,
            media_type: type === "series" ? "tv" : "movie",
          };
        }
      }
      if (!cancelled) {
        targetRef.current = resolved;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [metaId, season, episode, src.imdbId, src.meta.type]);

  const saveResumeNow = (posSec: number, durSec: number, isBeacon = false) => {
    const target = targetRef.current;
    if (!target || durSec < STUB_MAX_SEC) return;

    const ratio = durSec > 0 ? posSec / durSec : 0;
    if (ratio < 0.02) return;

    const posMs = posSec * 1000;
    const durMs = durSec * 1000;

    if (ratio >= COMPLETION_RATIO) {
      void markPmdbWatched(target);
      return;
    }

    if (isBeacon) {
      pmdbBeaconResume(target, posMs, durMs);
    } else {
      lastSaveTimeRef.current = Date.now();
      lastSavedPosRef.current = posSec;
      void pmdbSaveResume(target, posMs, durMs);
    }
  };

  // Handle page hide / app close
  useEffect(() => {
    if (!enabled) return;

    const onPageHide = () => {
      const dur = snap.durationSec;
      if (dur < STUB_MAX_SEC) return;
      const live = getPlaybackPosition();
      saveResumeNow(live, dur, true);
    };

    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [enabled, snap.durationSec]);

  // Handle item change: save previous if needed
  useEffect(() => {
    if (lastKeyRef.current && lastKeyRef.current !== key) {
      const prevDur = snap.durationSec;
      if (enabled && prevDur >= STUB_MAX_SEC && targetRef.current) {
        const live = getPlaybackPosition();
        saveResumeNow(live, prevDur);
      }
    }
    lastKeyRef.current = key;
  }, [enabled, key]);

  // Playback state transitions
  useEffect(() => {
    if (!enabled || !targetRef.current) return;
    if (snap.durationSec < STUB_MAX_SEC) return;

    const liveSec = getPlaybackPosition();
    const ratio = snap.durationSec > 0 ? liveSec / snap.durationSec : 0;

    if (snap.status === "ended") {
      if (!endedHandledRef.current) {
        endedHandledRef.current = true;
        if (ratio >= COMPLETION_RATIO) {
          void markPmdbWatched(targetRef.current);
        }
      }
      return;
    }

    if (snap.status === "paused") {
      saveResumeNow(liveSec, snap.durationSec);
      return;
    }

    // While playing, periodically save if elapsed interval >= 30s and position changed significantly
    if (snap.status === "playing") {
      const now = Date.now();
      if (
        now - lastSaveTimeRef.current >= MIN_SAVE_INTERVAL_MS &&
        Math.abs(liveSec - lastSavedPosRef.current) >= 15
      ) {
        saveResumeNow(liveSec, snap.durationSec);
      }
    }
  }, [enabled, snap.status, snap.positionSec, snap.durationSec]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (!enabled || !targetRef.current) return;
      const dur = snap.durationSec;
      if (dur >= STUB_MAX_SEC) {
        const live = getPlaybackPosition();
        saveResumeNow(live, dur, true);
      }
    };
  }, [enabled]);
}
