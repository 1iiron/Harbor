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
import { resolveNuvioProfileIndex } from "../src/lib/nuvio/nuvio-sync";
import { signOutNuvio } from "../src/lib/nuvio/nuvio-auth";

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
