import { invoke } from "@tauri-apps/api/core";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Writes one line into mpv's own log.
 *
 * A release build's only log is mpv's, and a bare `Set property: pause` line
 * cannot say which of the several controls asked for the change. Every path
 * that drives pause/play tags itself here, so a user report names the caller
 * without needing a debug build or a console capture.
 */
export function tracePlayback(line: string): void {
  if (!isTauri) return;
  void invoke("mpv_command", { cmd: ["print-text", `harbor: ${line}`] }).catch(() => {});
}

/**
 * Records mpv's frame counters beside a playback event.
 *
 * A freeze that resumes where it stopped is a hold (pause, cache, output
 * rebuild); one that jumps forward dropped frames. The counters say which, in
 * the same log a release build already produces.
 */
export function traceFrameDrops(reason: string): void {
  if (!isTauri) return;
  const read = (name: string) =>
    invoke<number | null>("mpv_get_property", { name }).catch(() => null);
  void Promise.all([read("frame-drop-count"), read("decoder-frame-drop-count")]).then(
    ([dropped, decoderDropped]) =>
      tracePlayback(`frames ${reason} dropped=${dropped ?? "?"} decoder=${decoderDropped ?? "?"}`),
  );
}
