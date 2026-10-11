import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as episodeTextLanguage from "../src/lib/episode-text-language.ts";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

function load(file, dependencies) {
  const source = readFileSync(new URL("../" + file, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    require: (name) => {
      assert.ok(name in dependencies, "unmocked dependency " + name);
      return dependencies[name];
    },
  });
  return module.exports;
}

function providerFixture({ fail = false, localizedOverview = " ", missingEnglish = false } = {}) {
  const calls = [];
  const requests = [];
  const tvdb = load("src/lib/providers/tvdb.ts", {
    "@/lib/episode-text-language": episodeTextLanguage,
    "@/lib/cache": { lruSet: (map, key, value) => map.set(key, value) },
    "@/lib/memory-profiler": { registerCache: () => {} },
    "@/lib/config/endpoints": { HARBOR_TVDB_BASE: "https://mock.invalid" },
    "@/lib/safe-fetch": {
      safeFetch: async (url, options) => {
        requests.push({ url, options });
        const path = new URL(url).pathname;
        calls.push(path);
        if (path.endsWith("/login"))
          return { ok: true, json: async () => ({ data: { token: "test-token" } }) };
        if (fail) return { ok: false, status: 404 };
        if (path.includes("/series/"))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                seasons: [{ ...season, name: "Saga française", type: { type: "official" } }],
              },
            }),
          };
        if (missingEnglish && path.endsWith("/eng")) return { ok: false, status: 404 };
        const data = path.endsWith("/fra")
          ? { name: "Saga française", overview: localizedOverview }
          : path.endsWith("/eng")
            ? { name: "English Saga", overview: "English season synopsis" }
            : {
                image: "/default.jpg",
                artwork: [
                  { type: 7, language: "eng", score: 99, image: "/english.jpg" },
                  { type: 7, language: "fra", score: 2, image: "/french.jpg" },
                  {
                    type: 6,
                    width: 758,
                    height: 140,
                    language: "fra",
                    score: 100,
                    image: "/banner.jpg",
                  },
                  { width: 1920, height: 1080, score: 10, image: "/background.jpg" },
                ],
              };
        return { ok: true, status: 200, json: async () => ({ data }) };
      },
    },
  });
  const details = load("src/lib/providers/tvdb-season-details.ts", { "./tvdb": tvdb });
  return { ...tvdb, ...details, calls, requests };
}

const season = {
  id: 31893,
  number: 1,
  name: "East Blue",
  image: "https://artworks.thetvdb.com/base.jpg",
};

test("selected season uses its own TVDB ID, localized poster, and per-field English fallback", async () => {
  const f = providerFixture();
  const result = await f.fetchTvdbSeasonDetails("test-key", season, "fra");
  assert.equal(result.name, "English Saga");
  assert.equal(result.overview, "English season synopsis");
  assert.equal(result.poster, "https://artworks.thetvdb.com/french.jpg");
  assert.equal(result.background, "https://artworks.thetvdb.com/background.jpg");
  assert.deepEqual(f.calls.filter((path) => path.includes("/seasons/")).sort(), [
    "/v4/seasons/31893/extended",
    "/v4/seasons/31893/translations/eng",
    "/v4/seasons/31893/translations/fra",
  ]);
});

test("revisiting a season reuses cached requests and English requires just one translation", async () => {
  const f = providerFixture();
  await f.fetchTvdbSeasonDetails("test-key", season, "eng");
  const callCount = f.calls.length;
  await f.fetchTvdbSeasonDetails("test-key", season, "eng");
  assert.equal(f.calls.length, callCount);
  assert.equal(f.calls.filter((path) => path.includes("/translations/")).length, 1);
});

test("proxy-only users load translated season details and artwork without authentication", async () => {
  const f = providerFixture();
  const result = await f.fetchTvdbSeasonDetails("", season, "fra");
  assert.equal(result.name, "English Saga");
  assert.equal(result.overview, "English season synopsis");
  assert.equal(result.poster, "https://artworks.thetvdb.com/french.jpg");
  assert.equal(f.requests.length, 3);
  for (const request of f.requests) {
    assert.ok(request.url.startsWith("https://mock.invalid/api/tvdb/v4/seasons/31893/"));
    assert.equal(request.options.headers.authorization, undefined);
  }
});

test("unavailable proxy metadata falls back to the base season", async () => {
  const f = providerFixture({ fail: true });
  const result = await f.fetchTvdbSeasonDetails("", season, "eng");
  assert.equal(result.name, undefined);
  assert.equal(result.poster, season.image);
  assert.equal(result.overview, undefined);
});

test("seasons without a TVDB ID preserve base data without requests", async () => {
  const f = providerFixture();
  const result = await f.fetchTvdbSeasonDetails("", { ...season, id: null }, "eng");
  assert.equal(result.name, undefined);
  assert.equal(result.poster, season.image);
  assert.equal(f.calls.length, 0);
});

test("missing season metadata degrades to the base poster", async () => {
  const f = providerFixture({ fail: true });
  const result = await f.fetchTvdbSeasonDetails("test-key", season, "eng");
  assert.equal(result.poster, season.image);
  assert.equal(result.overview, undefined);
});

test("season artwork rejects banners and chooses English then textless posters", () => {
  const { pickSeasonPoster } = providerFixture();
  const artwork = [
    { type: 6, image: "/banner.jpg", language: "tur", score: 100 },
    { type: 7, image: "/japanese.jpg", language: "jpn", score: 99 },
    { type: 7, image: "/neutral.jpg", language: "", includesText: false, score: 10 },
  ];
  assert.equal(
    pickSeasonPoster({ artwork, lang: "tur" }),
    "https://artworks.thetvdb.com/neutral.jpg",
  );
  artwork.push({ type: 7, image: "/english.jpg", language: "eng", score: 1 });
  assert.equal(
    pickSeasonPoster({ artwork, lang: "tur" }),
    "https://artworks.thetvdb.com/english.jpg",
  );
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};

function hookFixture({ catalog, detail } = {}) {
  const state = [],
    effects = [],
    cleanups = [],
    dependencies = [];
  const calls = [];
  let stateIndex = 0,
    effectIndex = 0;
  const react = {
    useMemo: (callback) => callback(),
    useState: (initial) => {
      const index = stateIndex++;
      if (!(index in state)) state[index] = initial;
      return [
        state[index],
        (value) => {
          state[index] = typeof value === "function" ? value(state[index]) : value;
        },
      ];
    },
    useEffect: (effect, deps) => {
      const index = effectIndex++;
      if (dependencies[index]?.every((value, i) => Object.is(value, deps[i]))) return;
      effects.push(() => {
        cleanups[index]?.();
        cleanups[index] = effect();
      });
      dependencies[index] = deps;
    },
  };
  const hook = load("src/views/detail/use-season-explorer.ts", {
    react,
    "@/lib/providers/anime-mapping": { kitsuToTvdb: async (id) => id },
    "@/lib/providers/kitsu": {
      parseKitsuId: (id) => Number(/^kitsu:(\d+)$/.exec(id)?.[1]) || null,
    },
    "@/lib/season-name": { isGenericSeasonName: (name, n) => name === `Season ${n}` },
    "@/lib/providers/tvdb": {
      tvdbSeasonNames: async () => new Map(),
      tvdbSeriesByRemote: async () => 81797,
      tvdbSeasons:
        catalog ??
        (async () =>
          new Map([
            [1, season],
            [2, { ...season, id: 31894, number: 2 }],
          ])),
    },
    "@/lib/providers/tvdb-season-details": {
      fetchTvdbSeasonDetails: async (_key, info, lang) => {
        calls.push({ id: info.id, number: info.number, lang });
        return detail ? detail(info) : { overview: `Season ${info.number} synopsis` };
      },
    },
  });
  return {
    calls,
    englishSeasonItems: hook.englishSeasonItems,
    render: (props) => {
      stateIndex = 0;
      effectIndex = 0;
      const result = hook.useSeasonExplorer(props);
      effects.splice(0).forEach((effect) => effect());
      return result;
    },
    unmount: () => cleanups.forEach((cleanup) => cleanup?.()),
  };
}

const props = {
  metaId: "kitsu:81797",
  tvdbKey: "test-key",
  seasonType: "official",
  lang: "eng",
  activeSeason: 1,
};

test("changing seasons discards late synopses and only enriches selected seasons", async () => {
  const first = deferred();
  const f = hookFixture({
    detail: (info) => (info.number === 1 ? first.promise : { overview: "Second synopsis" }),
  });
  f.render(props);
  await flush();
  f.render(props);
  f.render({ ...props, activeSeason: 2 });
  await flush();
  first.resolve({ overview: "Late first synopsis" });
  await flush();
  const result = f.render({ ...props, activeSeason: 2 });
  assert.equal(result.details.get(2).overview, "Second synopsis");
  assert.equal(result.details.has(1), false);
  assert.equal(result.loading, false);
  assert.deepEqual(
    f.calls.map((call) => call.id),
    [31893, 31894],
  );
  f.unmount();
});

test("changing titles or languages immediately hides previous season details", async () => {
  const f = hookFixture();
  f.render(props);
  await flush();
  f.render(props);
  await flush();
  assert.equal(f.render(props).details.get(1).overview, "Season 1 synopsis");
  for (const changed of [
    { ...props, metaId: "kitsu:99" },
    { ...props, lang: "fra" },
  ]) {
    const result = f.render(changed);
    assert.equal(result.details.size, 0);
    assert.equal(result.seasons.size, 0);
  }
  f.unmount();
});

test("the explorer enriches the selected season without a personal key", async () => {
  const f = hookFixture();
  const noKey = { ...props, tvdbKey: "" };
  f.render(noKey);
  await flush();
  f.render(noKey);
  await flush();
  const result = f.render(noKey);
  assert.equal(result.details.get(1).overview, "Season 1 synopsis");
  assert.equal(result.loading, false);
  assert.equal(f.calls.length, 1);
  f.unmount();
});

test("extras do not inherit a numbered season synopsis", async () => {
  const f = hookFixture();
  const extras = { ...props, activeSeason: undefined };
  f.render(extras);
  await flush();
  f.render(extras);
  await flush();
  assert.equal(f.calls.length, 0);
  f.unmount();
});

test("season title stays English while the synopsis follows the metadata language", async () => {
  const f = providerFixture({ localizedOverview: "Résumé français" });
  const result = await f.fetchTvdbSeasonDetails("", season, "fra");
  assert.equal(result.name, "English Saga");
  assert.equal(result.overview, "Résumé français");
});

test("missing English translation never falls back to a foreign or original title", async () => {
  const f = providerFixture({ localizedOverview: "Résumé français", missingEnglish: true });
  const result = await f.fetchTvdbSeasonDetails("", { ...season, name: "日本語" }, "fra");
  assert.equal(result.name, undefined);
  assert.equal(result.overview, "Résumé français");
});

test("poster and dropdown items share English titles and preserve season identity", () => {
  const { englishSeasonItems } = hookFixture();
  const items = [
    { key: "4", seasonNumber: 4, name: "日本語", count: 12 },
    { key: "5", seasonNumber: 5, name: "Saison cinq", count: 20 },
    { key: "0", seasonNumber: 0, name: "特別", count: 3 },
    { key: "extra", name: "Movie", count: 1 },
  ];
  const names = new Map([[4, "High School DxD HERO"]]);
  const result = englishSeasonItems(items, names, new Map());
  assert.equal(result[0].name, "High School DxD HERO");
  assert.equal(result[0].seasonNumber, 4);
  assert.equal(result[0].count, 12);
  assert.equal(result[0].isGenericName, false);
  assert.equal(result[1].name, "Season 5");
  assert.equal(result[1].isGenericName, true);
  assert.equal(result[2].name, "Specials");
  assert.equal(result[3], items[3]);
  assert.equal(items[0].name, "日本語");
});

test("hidden explorer views do not request season metadata", async () => {
  const f = hookFixture();
  f.render({ ...props, enabled: false });
  await flush();
  f.render({ ...props, enabled: false });
  assert.equal(f.calls.length, 0);
  f.unmount();
});

function seasonExplorerComponent() {
  const { SeasonExplorer } = load("src/views/detail/season-explorer.tsx", {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": {
      Film: () => null,
      CalendarDays: () => null,
      ChevronLeft: () => null,
      ChevronRight: () => null,
    },
    "@/lib/horizontal-scroll": {
      horizontalScrollState: () => ({ rtl: false, max: 0, position: 0 }),
    },
    "@/lib/use-reduced-motion": { useReducedMotion: () => false },
    "./season-explorer.css": {},
    "@/components/player/subtitle-menu/marquee-motion": load(
      "src/components/player/subtitle-menu/marquee-motion.ts",
      {},
    ),
    "@/lib/i18n": { useT: () => (key, vars) => key.replace("{n}", String(vars?.n ?? "")) },
    "@/lib/season-name": { isGenericSeasonName: (name, n) => name === `Season ${n}` },
    "./synopsis": { Synopsis: ({ text }) => React.createElement("p", null, text) },
  });
  return SeasonExplorer;
}

test("English season titles render beside the original dropdown-style number badge", () => {
  const SeasonExplorer = seasonExplorerComponent();
  const html = renderToStaticMarkup(
    React.createElement(SeasonExplorer, {
      activeKey: "4",
      onSelect: () => {},
      data: {
        items: [{ key: "4", seasonNumber: 4, name: "High School DxD HERO", count: 12 }],
        seasons: new Map(),
        names: new Map(),
        loading: false,
        details: new Map([[4, { overview: "Résumé français" }]]),
      },
    }),
  );
  assert.match(html, /aria-label="Season 4 · High School DxD HERO · 12 episodes"/);
  assert.equal((html.match(/>Season 4<\/span>/g) ?? []).length, 2);
  assert.match(
    html,
    /rounded bg-ink\/10 px-1.5 py-px text-\[10.5px\] font-semibold text-ink-muted/,
  );
  assert.match(html, /Résumé français/);
});

test("season catalog names use English translations and never original-language Latin titles", async () => {
  const f = providerFixture();
  assert.equal((await f.tvdbSeasonNames("", 81797, "official")).get(1), "English Saga");
  const unavailable = providerFixture({ missingEnglish: true });
  assert.equal((await unavailable.tvdbSeasonNames("", 81797, "official")).size, 0);
});

test("season row excludes Extras while retaining season zero and episode-picker entries", () => {
  const SeasonExplorer = seasonExplorerComponent();
  const items = Object.freeze([
    Object.freeze({ key: "4", seasonNumber: 4, name: "English Saga", count: 12 }),
    Object.freeze({ key: "0", seasonNumber: 0, name: "Specials", count: 63, extra: true }),
    Object.freeze({ key: "specials", name: "Extras", count: 231, extra: true }),
    Object.freeze({ key: "-1", seasonNumber: -1, name: "Other extras", count: 2, extra: true }),
  ]);
  const data = { items, seasons: new Map(), names: new Map(), details: new Map(), loading: false };
  for (const activeKey of ["4", "specials"]) {
    const html = renderToStaticMarkup(
      React.createElement(SeasonExplorer, { data, activeKey, onSelect: () => {} }),
    );
    assert.match(html, /aria-label="Season 4 · English Saga · 12 episodes"/);
    assert.match(html, /aria-label="Specials · 63 episodes"/);
    assert.doesNotMatch(html, /Extras|Other extras|231 episodes/);
    if (activeKey === "specials") {
      assert.doesNotMatch(html, /aria-pressed="true"|aria-live="polite"/);
    }
  }
  assert.equal(data.items.length, 4);
  assert.equal(data.items[2].name, "Extras");
  assert.equal(
    renderToStaticMarkup(
      React.createElement(SeasonExplorer, {
        data: { ...data, items: [items[2], items[3]] },
        activeKey: "specials",
        onSelect: () => {},
      }),
    ),
    "",
  );
});
