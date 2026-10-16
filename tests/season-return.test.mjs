import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { getViewedSeason, setViewedSeason } from "../src/lib/season-view-pref.ts";
import { groupEpisodes, episodeNumber, episodeSeason } from "../src/views/detail/episode-groups.ts";
const require = createRequire(import.meta.url);
function load(path, mocks) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)(
    (id) => mocks[id] ?? (id === "react/jsx-runtime" ? require(id) : {}),
    exports,
  );
  return exports;
}

test("returning to Ozark restores season 3 and validates the available seasons", () => {
  const seasons = [1, 2, 3, 4].map((seasonNumber) => ({ seasonNumber }));
  setViewedSeason("tt5071412", 3);
  assert.equal(getViewedSeason("tt5071412", seasons), 3);
  assert.equal(getViewedSeason("another-show", seasons), undefined);
  assert.equal(getViewedSeason("tt5071412", [{ seasonNumber: 1 }]), undefined);
  setViewedSeason("specials-show", 0);
  assert.equal(getViewedSeason("specials-show", [{ seasonNumber: 0 }, { seasonNumber: 1 }]), 0);
});

test("Cinemeta episode grids restore the saved season after recreation", () => {
  const EpisodeGrid = () => null;
  const { CinemetaEpisodes } = load("src/views/detail/cinemeta-episodes.tsx", {
    react: {
      useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
      useSyncExternalStore: () => 0,
    },
    "@/lib/season-view-pref": { getViewedSeason, setViewedSeason },
    "@/lib/settings": {
      useSettings: () => ({
        settings: { episodeLayout: "grid", showEpisodeRating: true, omdbKey: "test-key" },
        update: () => {},
      }),
    },
    "@/lib/i18n": { useT: () => (value) => value },
    "@/lib/manual-watched": {
      manualEpisodeKeys: () => ({ watched: new Set(), unwatched: new Set() }),
    },
    "@/lib/local-library/use-series-play": { useLocalAwareSeriesPlay: () => () => {} },
    "@/lib/episode-progress": { resumeDefaultSeason: () => 1 },
    "./episode-groups": { groupEpisodes, episodeNumber, episodeSeason },
    "./helpers": { isUpcomingDate: () => false },
    "./episode-grid": { EpisodeGrid },
    "./use-episode-imdb-ratings": { useEpisodeImdbRatings: () => new Map([["3:1", 8.3]]) },
  });
  setViewedSeason("tt5071412", 3);
  const tree = CinemetaEpisodes({
    meta: { id: "tt5071412" },
    videos: [
      { season: 1, episode: 1 },
      { season: 3, episode: 1, name: "Wartime" },
    ],
  });
  function find(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === EpisodeGrid) return node;
    for (const child of [node.props?.children].flat(Infinity)) {
      const result = find(child);
      if (result) return result;
    }
  }
  const cards = find(tree).props.episodes;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].season, 3);
});
