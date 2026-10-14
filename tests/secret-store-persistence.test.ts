import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// A session that is written but never flushed is a session the listener loses: a
// rotated refresh token is invalid server-side the moment it is issued. These pin the
// rule that session and credential keys skip the debounce window.
const file = fileURLToPath(new URL("../src/lib/secret-store.ts", import.meta.url));

function harness() {
  const writes = [];
  const timers = [];
  const mocks = {
    "@tauri-apps/api/core": {
      invoke: async (command, args) => {
        if (command === "secrets_read") return null;
        if (command === "secrets_write") writes.push(JSON.parse(args.content));
        return null;
      },
    },
  };
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  globalThis.window = {
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  globalThis.localStorage = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };

  const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  const require = (name) => {
    if (mocks[name]) return mocks[name];
    throw new Error(`Unexpected import: ${name}`);
  };
  new Function("require", "module", "exports", compiled)(require, module, module.exports);
  return {
    api: module.exports,
    writes,
    timers,
    restore: () => {
      globalThis.window = originalWindow;
      globalThis.localStorage = originalStorage;
    },
  };
}

test("session keys persist immediately instead of waiting for the debounce", async () => {
  const h = harness();
  try {
    await h.api.loadSecrets();
    h.api.setSecret("harbor.trakt.session.v1.p1", JSON.stringify({ refreshToken: "r" }));
    await h.api.flushSecrets();
    assert.equal(h.timers.length, 0, "a session write must not wait for a timer");
    assert.ok(h.writes.length >= 1, "the session write landed without a timer");
    assert.deepEqual(h.writes[0], { "harbor.trakt.session.v1.p1": '{"refreshToken":"r"}' });
    h.api.setSecret("harbor.simkl.session.v1.p1", JSON.stringify({ accessToken: "a" }));
    await h.api.flushSecrets();
    assert.deepEqual(h.writes[h.writes.length - 1], {
      "harbor.trakt.session.v1.p1": '{"refreshToken":"r"}',
      "harbor.simkl.session.v1.p1": '{"accessToken":"a"}',
    });
    h.api.setSecret("harbor.trakt.session.v1.p1", null);
    await h.api.flushSecrets();
    assert.deepEqual(h.writes[h.writes.length - 1], {
      "harbor.simkl.session.v1.p1": '{"accessToken":"a"}',
    });
  } finally {
    h.restore();
  }
});

test("keys outside the session set still batch behind the debounce", async () => {
  const h = harness();
  try {
    await h.api.loadSecrets();
    h.api.setSecret("harbor.theme.choice", "dark");
    await Promise.resolve();
    assert.equal(h.writes.length, 0, "a plain key waits for the debounce");
    assert.equal(h.timers.length, 1);
    h.timers[0].fn();
    await h.api.flushSecrets();
    assert.ok(h.writes.length >= 1);
    assert.deepEqual(h.writes[h.writes.length - 1], { "harbor.theme.choice": "dark" });
  } finally {
    h.restore();
  }
});
