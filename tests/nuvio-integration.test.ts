import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  loadNuvioState,
  saveNuvioState,
  getNuvioAccountId,
  isNuvioSignedIn,
  refreshNuvioSession,
} from "../src/lib/nuvio/nuvio-client";
import {
  readCachedNuvioLibrary,
  writeCachedNuvioLibrary,
  clearNuvioLibraryCache,
  readNuvioCursor,
  writeNuvioCursor,
  recordTombstone,
  readTombstones,
  writePendingUpserts,
  readPendingUpserts,
  readPendingDeletes,
  writePendingDeletes,
  flushNuvioLibraryMutations,
} from "../src/lib/nuvio/nuvio-library";
import {
  rememberNuvioPin,
  verifyNuvioPinLocally,
  forgetNuvioPin,
  clearAllNuvioPinCaches,
  markNuvioProfileUnlocked,
  isNuvioProfileUnlocked,
  clearNuvioSessionUnlocks,
  refuseNuvioProfileSelect,
  setActiveNuvioProfile,
} from "../src/lib/nuvio/nuvio-profiles";
import {
  resolveNuvioProfileIndex,
  readCachedWatchProgress,
  writeCachedWatchProgress,
  clearCachedWatchProgress,
} from "../src/lib/nuvio/nuvio-sync";
import {
  readCachedNuvioPlaybackItems,
  writeCachedNuvioPlaybackItems,
  clearCachedPlaybackItems,
} from "../src/lib/nuvio/nuvio-playback";
import { saveResumeMs, readResumeEntry, clearResume } from "../src/lib/resume";

// Mock localStorage in node test environment
const mockStorage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => mockStorage.get(key) ?? null,
  setItem: (key: string, val: string) => {
    mockStorage.set(key, String(val));
  },
  removeItem: (key: string) => {
    mockStorage.delete(key);
  },
  clear: () => {
    mockStorage.clear();
  },
  key: (i: number) => Array.from(mockStorage.keys())[i] ?? null,
  get length() {
    return mockStorage.size;
  },
} as unknown as Storage;

// Mock window event dispatching
if (typeof globalThis.window === "undefined") {
  (globalThis as unknown as Record<string, unknown>).window = {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

test("Issue 1: Player scrobble hook is mounted in use-player-media pipeline and slot 0 maps correctly", () => {
  const playerMediaSrc = readFileSync(
    new URL("../src/views/player/hooks/use-player-media.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    playerMediaSrc,
    /import\s*\{\s*useNuvioScrobble\s*\}\s*from\s*["']@\/lib\/nuvio\/nuvio-scrobble-hook["']/,
    "useNuvioScrobble must be imported in use-player-media.ts",
  );
  assert.match(
    playerMediaSrc,
    /useNuvioScrobble\(\{\s*src,\s*snap,\s*season,\s*episode\s*\}\)/,
    "useNuvioScrobble must be mounted alongside Trakt, Simkl, and PMDB",
  );

  // Harbor profile 0 maps to Nuvio slot 1 (primary)
  assert.equal(resolveNuvioProfileIndex(0), 1);
  assert.equal(resolveNuvioProfileIndex("0"), 1);
  assert.equal(resolveNuvioProfileIndex(2), 2);
  assert.equal(resolveNuvioProfileIndex("nuvio-3"), 3);
});

test("Issue 2: Library cache, queues, cursors, and tombstones are strictly scoped by accountId", () => {
  mockStorage.clear();

  // User A logs in
  saveNuvioState({
    session: {
      access_token: "tok-a",
      refresh_token: "ref-a",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: { id: "user-aaa-111" },
    },
    profiles: [{ id: "p1", user_id: "user-aaa-111", profile_index: 1, name: "User A" }],
    activeProfileIndex: 1,
    lastSyncedAt: Date.now(),
  });
  assert.equal(getNuvioAccountId(), "user-aaa-111");

  writeCachedNuvioLibrary(1, [
    { content_id: "tt001", content_type: "movie", title: "User A Movie" },
  ]);
  writeNuvioCursor(1, 42);
  recordTombstone(1, "tt002", "movie");
  writePendingUpserts(1, [
    { content_id: "tt003", content_type: "movie", title: "Pending A" },
  ]);

  const itemsA = readCachedNuvioLibrary(1);
  assert.equal(itemsA.length, 1);
  assert.equal(itemsA[0].content_id, "tt001");
  assert.equal(readNuvioCursor(1), 42);
  assert.ok(readTombstones(1).has("tt002"));
  assert.equal(readPendingUpserts(1).length, 1);

  // User B logs in
  saveNuvioState({
    session: {
      access_token: "tok-b",
      refresh_token: "ref-b",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: { id: "user-bbb-222" },
    },
    profiles: [{ id: "p2", user_id: "user-bbb-222", profile_index: 1, name: "User B" }],
    activeProfileIndex: 1,
    lastSyncedAt: Date.now(),
  });
  assert.equal(getNuvioAccountId(), "user-bbb-222");

  // User B must NOT see User A's data
  const itemsB = readCachedNuvioLibrary(1);
  assert.equal(itemsB.length, 0, "User B must not see User A's library items");
  assert.equal(readNuvioCursor(1), null, "User B must not see User A's cursor");
  assert.equal(readTombstones(1).size, 0, "User B must not see User A's tombstones");
  assert.equal(readPendingUpserts(1).length, 0, "User B must not inherit User A's pending upserts");

  // clearNuvioLibraryCache purges all keys
  clearNuvioLibraryCache();
  for (const k of mockStorage.keys()) {
    assert.ok(!k.startsWith("harbor.nuvio.library."), `Stale library key remaining: ${k}`);
  }
});

test("Issue 3: PIN cache is account-scoped and purged on signout", async () => {
  mockStorage.clear();
  clearNuvioSessionUnlocks();

  // User A logs in
  saveNuvioState({
    session: {
      access_token: "tok-a",
      refresh_token: "ref-a",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: { id: "user-aaa-111" },
    },
    profiles: [
      { id: "p1", user_id: "user-aaa-111", profile_index: 1, name: "Profile 1" },
      { id: "p2", user_id: "user-aaa-111", profile_index: 2, name: "Profile 2", pin_enabled: true },
    ],
    activeProfileIndex: 1,
    lastSyncedAt: Date.now(),
  });

  await rememberNuvioPin(2, "1234");
  const unlockedLocallyA = await verifyNuvioPinLocally(2, "1234");
  assert.equal(unlockedLocallyA, true);

  // User B logs in
  saveNuvioState({
    session: {
      access_token: "tok-b",
      refresh_token: "ref-b",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: { id: "user-bbb-222" },
    },
    profiles: [
      { id: "pb1", user_id: "user-bbb-222", profile_index: 1, name: "User B Main" },
      { id: "pb2", user_id: "user-bbb-222", profile_index: 2, name: "User B Kid", pin_enabled: true },
    ],
    activeProfileIndex: 1,
    lastSyncedAt: Date.now(),
  });

  // User B profile 2 must NOT be unlocked by User A's PIN
  const unlockedLocallyB = await verifyNuvioPinLocally(2, "1234");
  assert.equal(unlockedLocallyB, false, "User B's profile 2 must not be unlocked with User A's cached PIN");

  // Sign out clears all PIN caches and session unlocks
  clearAllNuvioPinCaches();
  for (const k of mockStorage.keys()) {
    assert.ok(!k.startsWith("harbor.nuvio.pin_cache."), `Stale pin key remaining: ${k}`);
  }
});

test("Issue 4: In-flight refresh aborts if user signs out or switches accounts", async () => {
  mockStorage.clear();

  saveNuvioState({
    session: {
      access_token: "old-tok",
      refresh_token: "old-ref",
      expires_at: 100,
      token_type: "bearer",
      user: { id: "user-original" },
    },
    profiles: [],
    activeProfileIndex: 1,
    lastSyncedAt: null,
  });

  // Intercept fetch to simulate sign-out happening while refresh is in flight
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    // User logs out while fetch is pending!
    saveNuvioState({
      session: null,
      profiles: [],
      activeProfileIndex: 1,
      lastSyncedAt: null,
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-tok-zombie",
        refresh_token: "new-ref-zombie",
        expires_in: 3600,
        token_type: "bearer",
        user: { id: "user-original" },
      }),
    } as unknown as Response;
  };

  try {
    const res = await refreshNuvioSession();
    assert.equal(res, null, "refreshNuvioSession must abort if session was cleared during fetch");
    assert.equal(loadNuvioState().session, null, "Must not resurrect cleared session in state");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Issue 5: Settings profile switch successfully unlocks and switches locked profiles", () => {
  mockStorage.clear();
  clearNuvioSessionUnlocks();

  const profile2 = {
    id: "p2",
    user_id: "user-1",
    profile_index: 2,
    name: "Locked Profile",
    pin_enabled: true,
  };

  saveNuvioState({
    session: {
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 999999999,
      token_type: "bearer",
      user: { id: "user-1" },
    },
    profiles: [
      { id: "p1", user_id: "user-1", profile_index: 1, name: "Main Profile" },
      profile2,
    ],
    activeProfileIndex: 1,
    lastSyncedAt: null,
  });

  // Attempting to select without unlock should be refused
  const refused = refuseNuvioProfileSelect(profile2, new Set());
  assert.equal(refused, true);

  // Settings PIN flow unlocks slot and marks it
  markNuvioProfileUnlocked(2);
  assert.equal(isNuvioProfileUnlocked(2), true);

  // Now switching succeeds
  const switched = setActiveNuvioProfile(2, { unlocked: true });
  assert.equal(switched, true);
  assert.equal(loadNuvioState().activeProfileIndex, 2);
});

// ============================================================================
// Review 2 Follow-Up Regression Checks (6 Additional Hardened Gates)
// ============================================================================

test("Review 2 Issue 1: Private resume strictly isolates owner writes, reads, and clears", () => {
  mockStorage.clear();

  // 1. A write without explicit owner only enters shared KEY, never entering private scope
  saveResumeMs("tt100", 45000, 1, 1);
  const sharedRaw = mockStorage.get("harbor.resume");
  assert.ok(sharedRaw && sharedRaw.includes("tt100|s1e1"), "Unowned write must enter shared resume");
  assert.equal(
    mockStorage.has("harbor.resume.private.v1.alice"),
    false,
    "Unowned write must never enter active private profile",
  );

  // 2. An explicit owner write lands in both shared and private scopes
  saveResumeMs("tt101", 90000, 1, 1, undefined, undefined, undefined, "alice");
  const privateAlice = mockStorage.get("harbor.resume.private.v1.alice");
  assert.ok(privateAlice && privateAlice.includes("tt101|s1e1"), "Owner write must enter private profile");

  // 3. Clear with acknowledged option clears only active private scope without deleting shared progress
  mockStorage.set(
    "harbor.profiles.v1",
    JSON.stringify({
      activeId: "alice",
      profiles: [
        { id: "main", isPrimary: true },
        { id: "alice", shareStremioWith: "main" },
      ],
    }),
  );
  mockStorage.set("harbor.settings.shared", JSON.stringify({ cwPerProfile: true }));
  clearResume("tt101", 1, 1, { acknowledged: true });
  assert.equal(
    mockStorage.get("harbor.resume.private.v1.alice")?.includes("tt101|s1e1"),
    false,
    "Private clear must remove from private scope",
  );
  assert.ok(
    mockStorage.get("harbor.resume")?.includes("tt101|s1e1"),
    "Private clear must not delete from shared progress",
  );
});

test("Review 2 Issue 2: Nuvio watch progress and playback items are strictly scoped by accountId", () => {
  mockStorage.clear();

  // User A writes watch progress & playback items
  writeCachedWatchProgress(1, [{ content_id: "ttA", profile_id: 1, position_seconds: 120 } as any], "user-A");
  writeCachedNuvioPlaybackItems(1, [{ _id: "ttA", name: "Title A" } as any], "user-A");

  // User B reads their own slot 1
  const bProgress = readCachedWatchProgress(1, "user-B");
  const bItems = readCachedNuvioPlaybackItems(1, "user-B");
  assert.equal(bProgress.length, 0, "User B must not see User A's watch progress");
  assert.equal(bItems.length, 0, "User B must not see User A's playback items");

  // Sign out clears both caches
  clearCachedWatchProgress();
  clearCachedPlaybackItems();
  for (const k of mockStorage.keys()) {
    assert.ok(!k.startsWith("harbor.nuvio.watch_progress."), "Watch progress cache must be cleared");
    assert.ok(!k.startsWith("harbor.nuvio.playback_items."), "Playback items cache must be cleared");
  }
});

test("Review 2 Issue 3: Switching to Nuvio provider dynamically updates Continue Watching", () => {
  const cwSource = readFileSync(
    new URL("../src/lib/feed/external-cw.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    cwSource,
    /sourceMask\.nuvio\s*=\s*isNuvioProviderActive\(\)/,
    "onProfileChange and onSessionChange must dynamically refresh sourceMask.nuvio without requiring app reload",
  );
  assert.match(
    cwSource,
    /window\.addEventListener\(["']harbor:account-provider-changed["'],\s*onProfileChange\)/,
    "harbor:account-provider-changed must be wired to onProfileChange to update provider CW state",
  );
  assert.match(
    cwSource,
    /mask\.nuvio\s*!==\s*undefined\s*\?\s*mask\.nuvio\s*:\s*isNuvioProviderActive\(\)/,
    "setExternalCwSources must fall back to dynamic isNuvioProviderActive() instead of stale sourceMask",
  );
});

test("Review 2 Issue 4: Failed library delete retains item in pending queue", async () => {
  mockStorage.clear();

  saveNuvioState({
    session: { access_token: "tok", refresh_token: "ref", expires_at: 9999999, token_type: "bearer", user: { id: "u-del" } },
    profiles: [],
    activeProfileIndex: 1,
    lastSyncedAt: null,
  });

  writePendingDeletes(1, [{ content_id: "tt-fail-delete", content_type: "movie" }], "u-del");
  assert.equal(readPendingDeletes(1, "u-del").length, 1);

  // Simulate both RPC and direct table DELETE failing with HTTP 500
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ message: "Internal server error" }),
  } as unknown as Response);

  try {
    const success = await flushNuvioLibraryMutations(1);
    assert.equal(success, false, "Flush must return false on failed network delete");

    const remaining = readPendingDeletes(1, "u-del");
    assert.equal(remaining.length, 1, "Failed delete must be retained in pending queue");
    assert.equal(remaining[0].content_id, "tt-fail-delete");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Review 2 Issue 5: In-flight library flush aborts if user switches accounts", async () => {
  mockStorage.clear();

  saveNuvioState({
    session: { access_token: "tok-A", refresh_token: "ref-A", expires_at: 9999999, token_type: "bearer", user: { id: "user-A" } },
    profiles: [],
    activeProfileIndex: 1,
    lastSyncedAt: null,
  });

  writePendingDeletes(1, [{ content_id: "tt-user-A-item", content_type: "movie" }], "user-A");

  // Intercept fetch: while User A's flush is running, User B signs in
  const originalFetch = globalThis.fetch;
  let requestsMadeWithB = 0;
  globalThis.fetch = async (_url, init) => {
    // Switch to User B mid-flight
    saveNuvioState({
      session: { access_token: "tok-B", refresh_token: "ref-B", expires_at: 9999999, token_type: "bearer", user: { id: "user-B" } },
      profiles: [],
      activeProfileIndex: 1,
      lastSyncedAt: null,
    });
    const authHeader = (init?.headers as Record<string, string>)?.["Authorization"] || "";
    if (authHeader.includes("tok-B")) {
      requestsMadeWithB++;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  };

  try {
    const flushed = await flushNuvioLibraryMutations(1);
    assert.equal(flushed, false, "Flush must abort when account switches mid-flight");
    assert.equal(requestsMadeWithB, 0, "User A's mutations must never be dispatched with User B's token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Review 2 Issue 6: Session refresh race guards against late 401 and late success", async () => {
  mockStorage.clear();

  // Scenario A: Late 401 must not wipe a newer login to the same account
  saveNuvioState({
    session: { access_token: "tok-1", refresh_token: "ref-1", expires_at: 100, token_type: "bearer", user: { id: "u-same" } },
    profiles: [],
    activeProfileIndex: 1,
    lastSyncedAt: null,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    // While refresh is in flight, user logs in with newer credentials (ref-2)
    saveNuvioState({
      session: { access_token: "tok-2", refresh_token: "ref-2", expires_at: 99999, token_type: "bearer", user: { id: "u-same" } },
      profiles: [],
      activeProfileIndex: 1,
      lastSyncedAt: null,
    });
    return { ok: false, status: 401 } as unknown as Response;
  };

  try {
    const res = await refreshNuvioSession();
    assert.equal(res, null);
    const state = loadNuvioState();
    assert.ok(state.session !== null, "Late 401 must not wipe newer session");
    assert.equal(state.session?.refresh_token, "ref-2", "Newer session must be preserved");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Scenario B: Late success must not overwrite a newer login to the same account
  globalThis.fetch = async () => {
    // User renewed with ref-3 while ref-2 was refreshing
    saveNuvioState({
      session: { access_token: "tok-3", refresh_token: "ref-3", expires_at: 99999, token_type: "bearer", user: { id: "u-same" } },
      profiles: [],
      activeProfileIndex: 1,
      lastSyncedAt: null,
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "stale-tok", refresh_token: "stale-ref", expires_in: 3600 }),
    } as unknown as Response;
  };

  try {
    const res = await refreshNuvioSession();
    assert.equal(res, null, "Late success must be rejected when newer session exists");
    assert.equal(loadNuvioState().session?.refresh_token, "ref-3", "Newer session token must not be overwritten");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
