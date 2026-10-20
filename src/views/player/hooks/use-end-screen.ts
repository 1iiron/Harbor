import { useCallback, useEffect, useRef, useState } from "react";
import type { Meta } from "@/lib/cinemeta";
import type { PlayerSnapshot } from "@/lib/player/bridge";
import { getPlaybackPosition, subscribePlaybackClock } from "@/lib/player/playback-clock";
import { isNaturalEnd } from "@/lib/player/playback-end";
import { loadMoreLikeThis } from "@/lib/recommendations";
import type { PlayEpisode, PlayerSrc } from "@/lib/view";

/** Short stubs and clips should never get a recommendation screen. */
const MIN_DURATION_SEC = 90;

export type EndScreenMode = "full" | "shrink";

export type EndScreenState = {
  open: boolean;
  mode: EndScreenMode;
  items: Meta[];
  focused: number;
  countdown: number | null;
  countdownTotal: number;
  focus: (index: number) => void;
  interact: () => void;
  dismiss: () => void;
};

export function useEndScreen(params: {
  src: PlayerSrc;
  snap: PlayerSnapshot;
  enabled: boolean;
  leadSec: number;
  countdownSec: number;
  onZero: "close" | "play";
  tmdbKey: string | null;
  isLive: boolean;
  nextEp: PlayEpisode | null;
  canChangeEpisode: boolean;
  roomGuest: boolean;
  onPlay: (meta: Meta) => void;
  onClose: () => void;
}): EndScreenState {
  const {
    src,
    snap,
    enabled,
    leadSec,
    countdownSec,
    onZero,
    tmdbKey,
    isLive,
    nextEp,
    canChangeEpisode,
    roomGuest,
    onPlay,
    onClose,
  } = params;

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<EndScreenMode>("full");
  const [items, setItems] = useState<Meta[]>([]);
  const [focused, setFocused] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const firedEarlyRef = useRef<string | null>(null);
  const firedEndRef = useRef<string | null>(null);
  const earlySinceRef = useRef(0);
  const snapRef = useRef(snap);
  snapRef.current = snap;

  // Latest callbacks/mode without making the load effect depend on them.
  const latest = useRef({ mode, items, focused, onPlay, onClose });
  latest.current = { mode, items, focused, onPlay, onClose };

  // A new stream starts a new attempt.
  useEffect(() => {
    firedEarlyRef.current = null;
    firedEndRef.current = null;
    earlySinceRef.current = 0;
    setOpen(false);
    setItems([]);
    setFocused(0);
    setCountdown(null);
  }, [src.url]);

  // Changing the lead time re-arms the early card even if it was dismissed.
  useEffect(() => {
    firedEarlyRef.current = null;
    earlySinceRef.current = 0;
  }, [leadSec]);

  // Open at the chosen moment. Series episodes with a next episode keep the
  // existing up-next flow; live and resume stubs never show the screen.
  //
  // The clock is watched through a plain subscription: this lives in the player
  // view, and subscribing React to the 100 ms clock would redraw the whole player.
  useEffect(() => {
    if (!enabled || open || isLive || leadSec === 0) return;
    if (snap.durationSec < MIN_DURATION_SEC) return;
    if ((canChangeEpisode || roomGuest) && nextEp) return;

    const evaluate = () => {
      const current = snapRef.current;
      if (current.durationSec < MIN_DURATION_SEC) return;
      const duration = current.durationSec;
      const position = getPlaybackPosition();

      // Back near the start means a replay or a start-over; arm the card again.
      if (position > 0 && position < 30) {
        firedEarlyRef.current = null;
        firedEndRef.current = null;
      }

      const natural = isNaturalEnd(current, position);
      const ended = current.status !== "playing" && position >= duration - 1;
      if (natural || ended) {
        if (firedEndRef.current === src.url) return;
        firedEndRef.current = src.url;
        setMode("full");
        setOpen(true);
        return;
      }

      // A lead longer than the film itself can never reach its mark.
      if (leadSec <= 0 || leadSec >= duration) return;
      const windowStart = duration - leadSec;
      if (position < windowStart) {
        earlySinceRef.current = 0;
        return;
      }
      // A replay flashes the old near-end position for a moment before it seeks
      // back to the start. Require the window to hold before acting on it.
      if (earlySinceRef.current === 0) earlySinceRef.current = Date.now();
      if (Date.now() - earlySinceRef.current < 1500) return;
      if (firedEarlyRef.current === src.url) return;
      firedEarlyRef.current = src.url;
      setMode("shrink");
      setOpen(true);
    };

    evaluate();
    return subscribePlaybackClock(evaluate);
  }, [
    canChangeEpisode,
    enabled,
    isLive,
    leadSec,
    nextEp,
    open,
    roomGuest,
    snap.durationSec,
    src.url,
  ]);

  // The film can reach its end while the early screen is up; at that point the
  // mini player no longer has anything to show, so the card goes full-screen.
  useEffect(() => {
    if (!open || mode !== "shrink") return;
    if (!isNaturalEnd(snap, getPlaybackPosition())) return;
    setMode("full");
  }, [mode, open, snap]);

  // Starting over (or replaying) while the card is up means the user is
  // watching again; step aside instead of leaving them stuck on the card.
  useEffect(() => {
    if (!open) return;
    const check = () => {
      const current = snapRef.current;
      if (current.durationSec <= 0) return;
      const position = getPlaybackPosition();
      if (position > 0 && position < 30) {
        setOpen(false);
        setCountdown(null);
      }
    };
    return subscribePlaybackClock(check);
  }, [open]);

  // Load recommendations once the screen opens.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void loadMoreLikeThis(src.meta, tmdbKey).then((list) => {
      if (!alive) return;
      if (list.length === 0) {
        const { mode: currentMode, onClose: close } = latest.current;
        setOpen(false);
        if (currentMode === "full") close();
        return;
      }
      setItems(list);
      setFocused(0);
    });
    return () => {
      alive = false;
    };
  }, [open, src.meta, tmdbKey]);

  // Countdown. Any interaction cancels it for the rest of this screen.
  useEffect(() => {
    if (!open || countdownSec <= 0) {
      setCountdown(null);
      return;
    }
    setCountdown(countdownSec);
    const id = window.setInterval(() => {
      setCountdown((value) => (value == null ? null : Math.max(0, value - 1)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [open, countdownSec]);

  useEffect(() => {
    if (!open || countdown !== 0) return;
    const {
      mode: currentMode,
      items: list,
      focused: index,
      onPlay: play,
      onClose: close,
    } = latest.current;
    if (onZero === "play" && list[index]) {
      play(list[index]);
      return;
    }
    // Closing the player is only safe once the film has actually finished.
    // In the early layout the card steps aside and playback keeps going.
    if (currentMode === "full") close();
    else {
      setOpen(false);
      setCountdown(null);
    }
  }, [countdown, onZero, open]);

  const focus = useCallback((index: number) => setFocused(index), []);
  const interact = useCallback(() => setCountdown(null), []);
  const dismiss = useCallback(() => {
    setOpen(false);
    setCountdown(null);
  }, []);

  return {
    open,
    mode,
    items,
    focused,
    countdown,
    countdownTotal: countdownSec,
    focus,
    interact,
    dismiss,
  };
}
