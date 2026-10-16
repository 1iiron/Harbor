import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export type InstallFeatureKey = "plugins" | "games" | "music" | "ebook" | "manga";
export type InstallFeatures = Record<InstallFeatureKey, boolean>;

const ALL_ON: InstallFeatures = {
  plugins: true,
  games: true,
  music: true,
  ebook: true,
  manga: true,
};

let snapshot: InstallFeatures = ALL_ON;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: InstallFeatures) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/** One read per session. A missing marker (dev builds, NSIS installs, other platforms) keeps
 * every feature on, so gating only ever removes what the installer was told to remove. */
function ensureLoaded() {
  if (loading) return;
  loading = invoke<Partial<InstallFeatures>>("install_features")
    .then((value) => publish({ ...ALL_ON, ...value }))
    .catch(() => {
      loading = null; // web preview or an older build: let the next mount try again
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  ensureLoaded();
  return () => {
    listeners.delete(listener);
  };
}

export function useInstallFeatures(): InstallFeatures {
  return useSyncExternalStore(subscribe, () => snapshot, () => ALL_ON);
}
