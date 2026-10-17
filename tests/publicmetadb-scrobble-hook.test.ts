import assert from "node:assert/strict";
import test from "node:test";
import { hookHarness, flushPromises } from "./helpers/hook-harness.ts";

function fixture(mark: () => Promise<boolean> = async () => true) {
  let now = 1_000_000;
  let position = 910;
  let marked = 0;
  let deleted = 0;
  let recorded = 0;
  const intervals = new Map<number, () => void>();
  let timerId = 0;
  const harness = hookHarness("src/lib/publicmetadb/scrobble-hook.ts", "usePublicMetaDbScrobble", {
    "@/lib/player/playback-clock": { getPlaybackPosition: () => position },
    "@/lib/settings": { useSettings: () => ({ settings: { publicmetadbScrobbleEnabled: true } }) },
    "./provider": { usePublicMetaDb: () => ({ isConnected: true }) },
    "./ids": { resolvePmdbTarget: async (id: string) => ({ tmdb_id: Number(id.split(":")[2]), media_type: "movie" }) },
    "./scrobble": {
      pmdbDeleteResumeForTarget: async () => { deleted++; return true; },
      pmdbSaveResume: async () => ({ action: "saved" }),
    },
    "./history": { markPmdbWatched: () => { marked++; return mark(); } },
    "./pending-sync": {
      recordPendingResume: () => { recorded++; return "pending"; },
      removePendingResume: () => {},
      pendingResumeKey: () => "pending",
    },
  }, {
    Date: { now: () => now },
    window: {
      setInterval: (callback: () => void) => { const id = ++timerId; intervals.set(id, callback); return id; },
      clearInterval: (id: number) => intervals.delete(id),
      clearTimeout: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  return {
    render(status = "playing", id = "tmdb:movie:550") {
      harness.render({ src: { meta: { id, type: "movie" } }, snap: { status, durationSec: 1000, positionSec: position } });
    },
    async tick(seconds = 1) {
      for (let i = 0; i < seconds; i++) {
        now += 1000;
        position++;
        for (const callback of intervals.values()) callback();
        await flushPromises();
      }
    },
    counts: () => ({ marked, deleted, recorded }),
    unmount: () => harness.unmount(),
  };
}

test("completed playback sends one watched write across ticks, pause, end and unmount", async () => {
  const h = fixture();
  h.render();
  await flushPromises();
  await h.tick(120);
  h.render("paused");
  h.render("ended");
  h.unmount();
  await flushPromises();
  assert.deepEqual(h.counts(), { marked: 1, deleted: 1, recorded: 1 });
});

test("completion stays single-flight while the watched write is pending", async () => {
  let finish!: (ok: boolean) => void;
  const h = fixture(() => new Promise((resolve) => { finish = resolve; }));
  h.render();
  await flushPromises();
  await h.tick(120);
  h.render("paused");
  assert.deepEqual(h.counts(), { marked: 1, deleted: 0, recorded: 1 });
  finish(true);
  await flushPromises();
  assert.equal(h.counts().deleted, 1);
  h.unmount();
});

test("failed completion preserves the outbox and retries no faster than once per minute", async () => {
  let attempts = 0;
  const h = fixture(async () => ++attempts > 1);
  h.render();
  await flushPromises();
  await h.tick();
  h.render("paused");
  h.render("playing");
  await h.tick(59);
  assert.deepEqual(h.counts(), { marked: 1, deleted: 0, recorded: 1 });
  await h.tick();
  assert.deepEqual(h.counts(), { marked: 2, deleted: 1, recorded: 2 });
  h.unmount();
});

test("a new media identity can complete after the previous title completed", async () => {
  const h = fixture();
  h.render();
  await flushPromises();
  await h.tick();
  h.render("playing", "tmdb:movie:551");
  await flushPromises();
  await h.tick();
  assert.deepEqual(h.counts(), { marked: 2, deleted: 2, recorded: 2 });
  h.unmount();
});
