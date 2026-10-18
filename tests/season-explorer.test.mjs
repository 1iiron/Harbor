import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as episodeTextLanguage from "../src/lib/episode-text-language.ts";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

function load(file, dependencies, globals = {}) {
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
    queueMicrotask,
    ...globals,
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

async function fetchCompleteSeason(f, key, info, lang) {
  const [text, artwork] = await Promise.all([
    f.fetchTvdbSeasonDetails(key, info, lang),
    f.fetchTvdbSeasonArtwork(key, info, lang),
  ]);
  return { ...text, ...artwork };
}

const season = {
  id: 31893,
  number: 1,
  name: "East Blue",
  image: "https://artworks.thetvdb.com/base.jpg",
};

test("selected season uses its own TVDB ID, localized poster, and per-field English fallback", async () => {
  const f = providerFixture();
  const result = await fetchCompleteSeason(f, "test-key", season, "fra");
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
  await fetchCompleteSeason(f, "test-key", season, "eng");
  const callCount = f.calls.length;
  await fetchCompleteSeason(f, "test-key", season, "eng");
  assert.equal(f.calls.length, callCount);
  assert.equal(f.calls.filter((path) => path.includes("/translations/")).length, 1);
});

test("proxy-only users load translated season details and artwork without authentication", async () => {
  const f = providerFixture();
  const result = await fetchCompleteSeason(f, "", season, "fra");
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
  const result = await fetchCompleteSeason(f, "", season, "eng");
  assert.equal(result.name, undefined);
  assert.equal(result.poster, season.image);
  assert.equal(result.overview, undefined);
});

test("seasons without a TVDB ID preserve base data without requests", async () => {
  const f = providerFixture();
  const result = await fetchCompleteSeason(f, "", { ...season, id: null }, "eng");
  assert.equal(result.name, undefined);
  assert.equal(result.poster, season.image);
  assert.equal(f.calls.length, 0);
});

test("missing season metadata degrades to the base poster", async () => {
  const f = providerFixture({ fail: true });
  const result = await fetchCompleteSeason(f, "test-key", season, "eng");
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

function hookFixture({ catalog, detail, artwork } = {}) {
  const state = [],
    effects = [],
    cleanups = [],
    dependencies = [];
  const calls = [];
  const artworkCalls = [];
  let stateIndex = 0,
    effectIndex = 0;
  const react = {
    useMemo: (callback) => callback(),
    useCallback: (callback) => callback,
    useRef: (initial) => react.useState({ current: initial })[0],
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
  const artworkProvider = load("src/lib/providers/tvdb-season-details.ts", {
    "./tvdb": {
      pickSeasonPoster: ({ extendedImage, baseImage }) => extendedImage ?? baseImage,
      tvdbSeasonExtended: async (_key, id) => {
        artworkCalls.push(id);
        return artwork ? artwork(id) : { image: `/preferred-${id}.jpg`, artwork: [] };
      },
    },
  });
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
      ...artworkProvider,
      fetchTvdbSeasonDetails: async (_key, info, lang) => {
        calls.push({ id: info.id, number: info.number, lang });
        return detail ? detail(info) : { overview: `Season ${info.number} synopsis` };
      },
    },
  });
  return {
    calls,
    artworkCalls,
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
  const result = await fetchCompleteSeason(f, "", season, "fra");
  assert.equal(result.name, "English Saga");
  assert.equal(result.overview, "Résumé français");
});

test("missing English translation never falls back to a foreign or original title", async () => {
  const f = providerFixture({ localizedOverview: "Résumé français", missingEnglish: true });
  const result = await fetchCompleteSeason(f, "", { ...season, name: "日本語" }, "fra");
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

function seasonExplorerComponent({ react = React, visibility = { observeWithin: () => () => {} }, globals = {} } = {}) {
  const { SeasonExplorer } = load("src/views/detail/season-explorer.tsx", {
    react,
    "react/jsx-runtime": jsxRuntime,
    "lucide-react": {
      Film: () => null,
      CalendarDays: () => null,
      ChevronLeft: () => null,
      ChevronRight: () => null,
    },
    "@/lib/visibility": visibility,
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
  }, globals);
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
        artwork: new Map(),
        setVisibleSeasons: () => {},
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
  const data = { items, seasons: new Map(), names: new Map(), details: new Map(), artwork: new Map(), setVisibleSeasons: () => {}, loading: false };
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

test("artwork and text load independently and concurrent artwork consumers share a request", async () => {
  const f = providerFixture();
  const [first, second] = await Promise.all([
    f.fetchTvdbSeasonArtwork("", season, "fra"),
    f.fetchTvdbSeasonArtwork("", season, "fra"),
  ]);
  assert.equal(first.poster, "https://artworks.thetvdb.com/french.jpg");
  assert.equal(second.poster, first.poster);
  assert.equal(f.calls.filter((path) => path.endsWith("/extended")).length, 1);
  assert.equal(f.calls.filter((path) => path.includes("/translations/")).length, 0);
  await f.fetchTvdbSeasonDetails("", season, "fra");
  assert.equal(f.calls.filter((path) => path.endsWith("/extended")).length, 1);
  assert.equal(f.calls.filter((path) => path.includes("/translations/")).length, 2);
  const textOnly = providerFixture();
  await textOnly.fetchTvdbSeasonDetails("", season, "eng");
  assert.equal(textOnly.calls.filter((path) => path.endsWith("/extended")).length, 0);
});

test("visible posters resolve before selection and stay stable when clicking and revisiting", async () => {
  const f = hookFixture();
  f.render(props);
  await flush();
  let result = f.render(props);
  result.setVisibleSeasons([1, 2]);
  await flush();
  f.render(props);
  await flush();
  result = f.render(props);
  const secondPoster = result.artwork.get(2).poster;
  assert.equal(secondPoster, "/preferred-31894.jpg");
  assert.equal(result.details.has(2), false);
  assert.deepEqual(f.calls.map((call) => call.number), [1]);
  f.render({ ...props, activeSeason: 2 });
  await flush();
  result = f.render({ ...props, activeSeason: 2 });
  assert.equal(result.artwork.get(2).poster, secondPoster);
  f.render(props);
  await flush();
  assert.deepEqual(f.artworkCalls, [31893, 31894]);
  assert.deepEqual(f.calls.map((call) => call.number), [1, 2]);
  f.unmount();
});

test("artwork requests stay bounded, prioritize selection, and skip offscreen seasons and Extras", async () => {
  const blocked = new Map(Array.from({ length: 8 }, (_, i) => [i, deferred()]));
  const f = hookFixture({
    catalog: async () => new Map(Array.from({ length: 9 }, (_, i) => [
      i - 1, { ...season, number: i - 1, id: i - 1 },
    ])),
    artwork: (id) => blocked.get(id).promise,
  });
  f.render(props);
  await flush();
  let result = f.render(props);
  result.setVisibleSeasons([-1, 0, 1, 2, 3, 4, 5]);
  f.render(props);
  assert.deepEqual(f.artworkCalls, [1, 0, 2]);
  f.render({ ...props, activeSeason: 5 });
  assert.equal(f.artworkCalls.length, 3);
  blocked.get(0).resolve({ image: "/specials.jpg", artwork: [] });
  await flush();
  assert.deepEqual(f.artworkCalls, [1, 0, 2, 5]);
  blocked.get(5).resolve({ image: "/five.jpg", artwork: [] });
  await flush();
  result = f.render({ ...props, activeSeason: 5 });
  assert.equal(result.artwork.get(5).poster, "/five.jpg");
  assert.equal(result.artwork.get(0).poster, "/specials.jpg");
  assert.equal(f.artworkCalls.includes(-1), false);
  assert.equal(f.artworkCalls.includes(6), false);
  assert.equal(f.artworkCalls.includes(7), false);
  f.unmount();
  for (const pending of blocked.values()) pending.resolve({ artwork: [] });
  await flush();
  assert.equal(f.artworkCalls.includes(4), false);
});

test("late artwork is discarded across title, language, order, API mode, and hidden-view changes", async () => {
  for (const changed of [
    { metaId: "kitsu:99" },
    { lang: "fra" },
    { seasonType: "dvd" },
    { tvdbKey: "" },
    { enabled: false },
  ]) {
    const pending = deferred();
    const f = hookFixture({ artwork: () => pending.promise });
    f.render(props);
    await flush();
    f.render(props);
    const nextProps = { ...props, ...changed };
    const hidden = f.render(nextProps);
    assert.equal(hidden.artwork.size, 0);
    pending.resolve({ image: "/stale.jpg", artwork: [] });
    await flush();
    // The replacement catalog has not yet been consumed by an effect.
    const next = f.render(nextProps);
    assert.equal(next.artwork.size, 0);
    f.unmount();
  }
});

test("failed artwork resolves to the default once and clicking does not retry it", async () => {
  const f = hookFixture({ artwork: async () => { throw new Error("unavailable"); } });
  f.render(props);
  await flush();
  f.render(props);
  await flush();
  let result = f.render(props);
  assert.equal(result.artwork.get(1).poster, season.image);
  result.setVisibleSeasons([1, 2]);
  f.render(props);
  await flush();
  f.render({ ...props, activeSeason: 2 });
  await flush();
  result = f.render(props);
  assert.equal(result.artwork.get(1).poster, season.image);
  assert.deepEqual(f.artworkCalls, [31893, 31894]);
  f.unmount();
});

test("poster cards and the selected panel use the same artwork and hide default posters while pending", () => {
  const SeasonExplorer = seasonExplorerComponent();
  const data = {
    items: [
      { key: "1", seasonNumber: 1, name: "Season 1", count: 10 },
      { key: "2", seasonNumber: 2, name: "Season 2", count: 10 },
    ],
    seasons: new Map([[1, { image: "/base-one.jpg" }], [2, { image: "/base-two.jpg" }]]),
    artwork: new Map([[1, { poster: "/preferred-one.jpg" }], [2, { poster: "/preferred-two.jpg" }]]),
    details: new Map([[1, { poster: "/wrong-detail.jpg", overview: "First synopsis" }]]),
    setVisibleSeasons: () => {},
    loading: false,
  };
  for (const activeKey of ["1", "2"]) {
    const html = renderToStaticMarkup(React.createElement(SeasonExplorer, {
      data, activeKey, onSelect: () => {},
    }));
    assert.equal((html.match(new RegExp('src="/preferred-' + (activeKey === "1" ? "one" : "two") + '.jpg"', "g")) ?? []).length, 2);
    assert.doesNotMatch(html, /base-one|base-two|wrong-detail/);
  }
  const pending = renderToStaticMarkup(React.createElement(SeasonExplorer, {
    data: { ...data, artwork: new Map() }, activeKey: "1", onSelect: () => {},
  }));
  assert.doesNotMatch(pending, /base-one|base-two|wrong-detail/);
});

test("season-strip visibility reports nearby cards to the artwork loader without selecting them", async () => {
  const f = hookFixture();
  f.render(props);
  await flush();
  const data = f.render(props);
  const cards = [1, 2].map((n) => ({ dataset: { seasonNumber: String(n) } }));
  const rail = { querySelectorAll: () => cards };
  const effects = [], observations = [];
  let released = 0;
  const SeasonExplorer = seasonExplorerComponent({
    react: {
      ...React,
      useRef: () => ({ current: rail }),
      useId: () => "season",
      useMemo: (compute) => compute(),
      useState: (initial) => [initial, () => {}],
      useEffect: (effect) => effects.push(effect),
      useCallback: (callback) => callback,
    },
    visibility: {
      observeWithin: (card, margin, callback, root) => {
        observations.push({ card, margin, callback, root });
        return () => { released++; };
      },
    },
  });
  SeasonExplorer({
    data: { ...data, items: cards.map((card) => ({
      key: card.dataset.seasonNumber,
      seasonNumber: Number(card.dataset.seasonNumber), name: "Season", count: 10,
    })) },
    activeKey: "1",
    onSelect: () => { throw new Error("visibility must not select a season"); },
  });
  const cleanup = effects[0]();
  assert.equal(observations.length, 2);
  for (const observation of observations) {
    assert.equal(observation.root, rail);
    assert.equal(observation.margin, "0px 180px");
    observation.callback({ isIntersecting: true });
  }
  await flush();
  f.render(props);
  await flush();
  assert.deepEqual(f.artworkCalls, [31893, 31894]);
  assert.deepEqual(f.calls.map((call) => call.number), [1]);
  cleanup();
  assert.equal(released, 2);
  f.unmount();
});

test("a failed preferred image falls back once and two failed images leave a placeholder", () => {
  const state = [];
  let index = 0;
  const SeasonExplorer = seasonExplorerComponent({
    react: {
      ...React,
      useRef: () => ({ current: null }),
      useId: () => "season",
      useMemo: (compute) => compute(),
      useState: (initial) => {
        const position = index++;
        if (!(position in state)) state[position] = initial;
        return [state[position], (value) => {
          state[position] = typeof value === "function" ? value(state[position]) : value;
        }];
      },
      useEffect: () => {},
      useCallback: (callback) => callback,
    },
  });
  const tree = SeasonExplorer({
    data: {
      items: [{ key: "1", seasonNumber: 1, name: "Season 1", count: 10 }],
      seasons: new Map([[1, { image: "/base.jpg" }]]),
      artwork: new Map([[1, { poster: "/preferred.jpg" }]]),
      details: new Map(),
      setVisibleSeasons: () => {},
      loading: false,
    },
    activeKey: "1",
    onSelect: () => {},
  });
  function findPoster(node) {
    if (node?.type?.name === "SeasonPoster") return node;
    for (const child of [node?.props?.children].flat()) {
      const found = child && findPoster(child);
      if (found) return found;
    }
  }
  const poster = findPoster(tree);
  assert.ok(poster);
  const stateStart = state.length;
  const render = () => {
    index = stateStart;
    return poster.type(poster.props);
  };
  let image = render();
  assert.equal(image.props.src, "/preferred.jpg");
  image.props.onError();
  image = render();
  assert.equal(image.props.src, "/base.jpg");
  image.props.onError();
  assert.equal(render().type, "div");
  assert.equal(render().type, "div");
});

test("failed synopsis loads retry on revisit without retrying successful empty responses", async () => {
  for (const failure of ["reject", "unavailable"]) {
    let attempts = 0;
    const f = hookFixture({
      detail: (info) => {
        if (info.number !== 1) return { overview: "Second synopsis" };
        if (++attempts === 1) {
          if (failure === "reject") throw new Error("temporary outage");
          return null;
        }
        return { overview: "Recovered synopsis" };
      },
    });
    f.render(props);
    await flush();
    f.render(props);
    await flush();
    assert.equal(f.render(props).details.has(1), false);
    assert.equal(f.render(props).loading, false);
    assert.equal(attempts, 1);
    f.render({ ...props, activeSeason: 2 });
    await flush();
    f.render(props);
    await flush();
    assert.equal(f.render(props).details.get(1).overview, "Recovered synopsis");
    f.unmount();
  }
  const f = hookFixture({ detail: () => ({}) });
  f.render(props);
  await flush();
  f.render(props);
  await flush();
  f.render({ ...props, activeSeason: 2 });
  await flush();
  f.render(props);
  assert.equal(f.calls.filter((call) => call.number === 1).length, 1);
  f.unmount();
});

test("unavailable season translations remain distinguishable from a successful empty translation", async () => {
  const unavailable = providerFixture({ fail: true });
  assert.equal(await unavailable.fetchTvdbSeasonDetails("", season, "eng"), null);
});

test("English season fallback preserves source provenance without accepting unknown or foreign names", () => {
  const { englishSeasonItems } = hookFixture();
  const original = [
    { key: "4", seasonNumber: 4, name: "The Final Season", nameLanguage: "en", count: 12 },
    { key: "5", seasonNumber: 5, name: "La dernière saison", nameLanguage: "fr", count: 12 },
    { key: "6", seasonNumber: 6, name: "Saigo no Kisetsu", nameLanguage: "und", count: 12 },
  ];
  const fallback = englishSeasonItems(original, new Map(), new Map());
  assert.equal(fallback[0].name, "The Final Season");
  assert.equal(fallback[0].isGenericName, false);
  assert.equal(fallback[1].name, "Season 5");
  assert.equal(fallback[2].name, "Season 6");
  const translated = englishSeasonItems(original, new Map([[4, "TVDB English Arc"]]), new Map());
  assert.equal(translated[0].name, "TVDB English Arc");
});

test("TMDB English season names survive both default and TVDB-fallback picker paths", async () => {
  const seasonNames = load("src/lib/season-name.ts", {});
  async function metadata(name, lang) {
    const requests = [];
    const { tmdbDetails } = load("src/lib/providers/tmdb/tmdb-details.ts", {
      "./tmdb-client": {
        IMG: "https://image.invalid",
        effectiveTmdbLanguage: () => lang,
        get: async (_key, path) => {
          requests.push(path);
          return path === "tv/42" ? {
            id: 42, name: "Example", images: {},
            seasons: [{ id: 44, season_number: 4, name, episode_count: 12 }],
          } : {};
        },
      },
      "./tmdb-image-rungs": { tmdbBackdropUrl: () => undefined, tmdbPosterUrl: () => undefined },
      "@/lib/settings/load": { loadStoredSettings: () => ({}) },
      "./tmdb-images": { pickLogo: () => undefined },
      "./tmdb-image-lang": { imageLangParam: () => "en", imageLangRank: () => 0 },
      "./tmdb-trailers": { pickTrailers: () => [] },
      "./tmdb-meta-mappers": { isAnimeItem: () => false },
      "@/lib/storage-recovery": {},
      "@/lib/episode-text-language": episodeTextLanguage,
      "@/lib/season-name": seasonNames,
    });
    const detail = await tmdbDetails("test-key", { id: "tmdb:tv:42", type: "series" });
    return { seasons: detail.seasons, requests };
  }
  const english = await metadata("The Final Season", "en-US");
  assert.equal(english.seasons[0].nameLanguage, "en");
  assert.equal(english.requests.length, 1);
  assert.equal((await metadata("La dernière saison", "fr")).seasons[0].nameLanguage, "und");
  assert.equal((await metadata("最終章", "en")).seasons[0].nameLanguage, "und");
  const { useSeasonArcPicker } = load("src/views/detail/series-episodes/use-season-arc-picker.ts", {
    react: { useMemo: (compute) => compute() },
    "@/lib/season-view-pref": {},
    "@/lib/providers/tvdb-order": {
      seasonDateRange: () => ({}),
      isGenericTvdbSeasonName: (name, n) => name === `Season ${n}`,
    },
    "../helpers": { isNewSeason: () => false },
    "@/lib/season-name": seasonNames,
  });
  const { englishSeasonItems } = hookFixture();
  for (const source of ["default", "order"]) {
    const picker = useSeasonArcPicker({
      source, arc: {}, seasons: english.seasons, active: 4, orderSeasonEff: 4,
      ordering: { seasons: [{ seasonNumber: 4, name: "Season 4", episodeCount: 12 }], bySeason: new Map() },
      tmdbSeasonNameFallback: true,
    });
    const [item] = englishSeasonItems(picker.items, new Map(), new Map());
    assert.equal(item.name, "The Final Season");
    assert.equal(item.nameLanguage, "en");
  }
});

function hookRuntime(initialRef = null) {
  const slots = [], effects = [];
  let index = 0, dirty = true;
  const memo = (compute, deps) => {
    const position = index++, previous = slots[position];
    if (!previous || !deps.every((value, i) => Object.is(value, previous.deps[i])))
      slots[position] = { deps, value: compute() };
    return slots[position].value;
  };
  const react = {
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useId: () => "id-" + index++,
    useRef: (initial) => {
      const position = index++;
      return slots[position] ??= { current: initialRef ?? initial };
    },
    useState: (initial) => {
      const position = index++;
      if (!(position in slots)) {
        const slot = { value: typeof initial === "function" ? initial() : initial };
        slot.set = (value) => {
          const next = typeof value === "function" ? value(slot.value) : value;
          if (!Object.is(next, slot.value)) {
            slot.value = next;
            dirty = true;
          }
        };
        slots[position] = slot;
      }
      return [slots[position].value, slots[position].set];
    },
    useEffect: (effect, deps) => {
      const position = index++, previous = slots[position];
      if (!previous || !deps.every((value, i) => Object.is(value, previous.deps[i])))
        effects.push(() => {
          previous?.cleanup?.();
          slots[position] = { deps, cleanup: effect() };
        });
    },
  };
  return {
    react,
    render: (compute) => { index = 0; dirty = false; return compute(); },
    commit: () => effects.splice(0).forEach((effect) => effect()),
    unmount: () => slots.forEach((slot) => slot.cleanup?.()),
    get dirty() { return dirty; },
  };
}

test("current series hooks settle with two visible cards even when item arrays are recreated", async () => {
  const cards = [1, 2].map((n) => ({ dataset: { seasonNumber: String(n) } }));
  const rail = { querySelectorAll: () => cards, querySelector: () => null };
  const parent = hookRuntime(), child = hookRuntime(rail);
  const react = parent.react, noop = () => {};
  const userPickedRef = { current: false };
  const seasons = [1, 2].map((n) => ({
    id: n, seasonNumber: n, name: "Season " + n, episodeCount: 12,
  }));
  const infos = new Map(seasons.map((s) => [s.id, { id: s.id, number: s.id }]));
  const { useArcGroups } = load("src/views/detail/series-episodes/use-arc-groups.ts", {
    react, "@/lib/providers/tmdb": {},
  });
  const { useSeasonArcPicker } = load("src/views/detail/series-episodes/use-season-arc-picker.ts", {
    react, "@/lib/season-view-pref": {}, "@/lib/providers/tvdb-order": {},
    "../helpers": { isNewSeason: () => false }, "@/lib/season-name": {},
  });
  const { useSeasonExplorerView } = load("src/views/detail/use-season-explorer.ts", {
    react, "@/lib/providers/anime-mapping": {},
    "@/lib/providers/kitsu": { parseKitsuId: () => null },
    "@/lib/season-name": { isGenericSeasonName: () => true },
    "@/lib/providers/tvdb": {
      tvdbSeasons: async () => infos,
      tvdbSeasonNames: async () => new Map(),
      tvdbSeriesByRemote: async () => 42,
    },
    "@/lib/providers/tvdb-season-details": {
      createSeasonArtworkLoader: () => ({ request: noop, dispose: noop }),
      fetchTvdbSeasonDetails: async () => ({}),
    },
  });
  const registrations = new Set();
  let subscriptions = 0, previousItems, settled = false;
  const SeasonExplorer = seasonExplorerComponent({
    react: child.react,
    globals: { ResizeObserver: class { observe() {} disconnect() {} } },
    visibility: {
      observeWithin: (_card, _margin, callback) => {
        subscriptions++;
        registrations.add(callback);
        return () => registrations.delete(callback);
      },
    },
  });
  for (let frame = 0; frame < 8; frame++) {
    const data = parent.render(() => {
      const arc = useArcGroups({ tvId: 42, tmdbKey: "", enabled: false });
      const picker = useSeasonArcPicker({
        source: "default", arc, seasons, active: 1, metaId: "tt123",
        setActive: noop, setOrderSeason: noop, userPickedRef,
      });
      if (previousItems && frame > 1) assert.equal(picker.items, previousItems);
      previousItems = picker.items;
      return useSeasonExplorerView({
        metaId: "tt123", tvdbKey: "", seasonType: "official", lang: "eng",
        items: [...picker.items], activeKey: "1",
      });
    });
    child.render(() => SeasonExplorer({ data, activeKey: "1", onSelect: noop }));
    parent.commit();
    child.commit();
    if (frame === 0)
      for (const callback of registrations) callback({ isIntersecting: true });
    await flush();
    if (!parent.dirty && !child.dirty) { settled = true; break; }
  }
  assert.equal(settled, true, "idle visibility updates must settle");
  assert.equal(subscriptions, 2, "same cards must keep their observers across refreshed arrays");
  child.unmount();
  parent.unmount();
  assert.equal(registrations.size, 0);
});

test("visibility changes publish one complete set and discard queued updates after cleanup", async () => {
  const cards = [1, 2].map((n) => ({ dataset: { seasonNumber: String(n) } }));
  const effects = [], callbacks = [], updates = [];
  const rail = { querySelectorAll: () => cards };
  const SeasonExplorer = seasonExplorerComponent({
    react: {
      ...React,
      useRef: () => ({ current: rail }), useId: () => "season",
      useMemo: (compute) => compute(), useState: (initial) => [initial, () => {}],
      useEffect: (effect) => effects.push(effect), useCallback: (callback) => callback,
    },
    visibility: { observeWithin: (_card, _margin, callback) => {
      callbacks.push(callback);
      return () => {};
    } },
  });
  SeasonExplorer({
    data: {
      items: cards.map((card) => ({
        key: card.dataset.seasonNumber, seasonNumber: Number(card.dataset.seasonNumber),
        name: "Season", count: 12,
      })),
      seasons: new Map(), details: new Map(), artwork: new Map(),
      setVisibleSeasons: (numbers) => updates.push([...numbers]),
    },
    activeKey: "1", onSelect: () => {},
  });
  const cleanup = effects[0]();
  for (const callback of callbacks) callback({ isIntersecting: true });
  assert.equal(updates.length, 0);
  await flush();
  assert.deepEqual(updates, [[1, 2]]);
  callbacks[0]({ isIntersecting: false });
  cleanup();
  await flush();
  assert.deepEqual(updates, [[1, 2]]);
});
