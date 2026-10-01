// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import "./_localstorage-stub.ts";
import {
  resolvePmdbEpisodeTarget,
  resolvePmdbTarget,
  stremioIdToPmdbTarget,
} from "../src/lib/publicmetadb/ids.ts";

test("stremioIdToPmdbTarget resolves TMDB movie IDs", () => {
  assert.deepEqual(stremioIdToPmdbTarget("tmdb:movie:550", undefined, "movie"), {
    tmdb_id: 550,
    media_type: "movie",
  });
});

test("stremioIdToPmdbTarget resolves TMDB TV show and episode IDs", () => {
  assert.deepEqual(stremioIdToPmdbTarget("tmdb:tv:1399", undefined, "series"), {
    tmdb_id: 1399,
    media_type: "tv",
  });

  assert.deepEqual(
    stremioIdToPmdbTarget("tmdb:tv:1399", { season: 1, episode: 1 }, "series"),
    {
      tmdb_id: 1399,
      media_type: "tv",
      season: 1,
      episode: 1,
    },
  );

  assert.deepEqual(stremioIdToPmdbTarget("tmdb:tv:1399:2:5"), {
    tmdb_id: 1399,
    media_type: "tv",
    season: 2,
    episode: 5,
  });
});

test("stremioIdToPmdbTarget resolves IMDb IDs for movies and series", () => {
  assert.deepEqual(stremioIdToPmdbTarget("tt0111161", undefined, "movie"), {
    id_type: "imdb",
    id_value: "tt0111161",
    media_type: "movie",
  });

  assert.deepEqual(stremioIdToPmdbTarget("tt0903747", undefined, "series"), {
    id_type: "imdb",
    id_value: "tt0903747",
    media_type: "tv",
  });

  assert.deepEqual(
    stremioIdToPmdbTarget("tt0903747", { season: 2, episode: 4 }, "series"),
    {
      id_type: "imdb",
      id_value: "tt0903747",
      media_type: "tv",
      season: 2,
      episode: 4,
    },
  );

  assert.deepEqual(stremioIdToPmdbTarget("tt0903747:1:1"), {
    id_type: "imdb",
    id_value: "tt0903747",
    media_type: "tv",
    season: 1,
    episode: 1,
  });
});

test("stremioIdToPmdbTarget resolves MAL and AniList targets", () => {
  assert.deepEqual(stremioIdToPmdbTarget("mal:21", { season: 1, episode: 5 }, "series"), {
    id_type: "mal",
    id_value: "21",
    media_type: "tv",
    season: 1,
    episode: 5,
  });

  assert.deepEqual(stremioIdToPmdbTarget("mal:5114", undefined, "movie"), {
    id_type: "mal",
    id_value: "5114",
    media_type: "movie",
  });

  assert.deepEqual(stremioIdToPmdbTarget("anilist:123", { season: 1, episode: 2 }, "series"), {
    id_type: "anilist",
    id_value: "123",
    media_type: "tv",
    season: 1,
    episode: 2,
  });
});

test("stremioIdToPmdbTarget returns null for invalid or unhandled IDs", () => {
  assert.equal(stremioIdToPmdbTarget(""), null);
  assert.equal(stremioIdToPmdbTarget("unknown:123"), null);
  assert.equal(stremioIdToPmdbTarget("tt_invalid"), null);
});

test("resolvePmdbEpisodeTarget resolves direct TMDB, IMDb, and MAL episodes", async () => {
  assert.deepEqual(
    await resolvePmdbEpisodeTarget("tmdb:tv:1399", { season: 1, episode: 1 }),
    {
      tmdb_id: 1399,
      media_type: "tv",
      season: 1,
      episode: 1,
    },
  );

  assert.deepEqual(
    await resolvePmdbEpisodeTarget("tt0903747", { season: 3, episode: 2 }),
    {
      id_type: "imdb",
      id_value: "tt0903747",
      media_type: "tv",
      season: 3,
      episode: 2,
    },
  );

  assert.deepEqual(
    await resolvePmdbEpisodeTarget("mal:21", { season: 1, episode: 7 }),
    {
      id_type: "mal",
      id_value: "21",
      media_type: "tv",
      season: 1,
      episode: 7,
    },
  );
});

test("resolvePmdbEpisodeTarget prefers verified IMDb identity when provided", async () => {
  assert.deepEqual(
    await resolvePmdbEpisodeTarget(
      "kitsu:1",
      { season: 1, episode: 14, imdbSeason: 2, imdbEpisode: 3 },
      "tt1234567",
    ),
    {
      id_type: "imdb",
      id_value: "tt1234567",
      media_type: "tv",
      season: 2,
      episode: 3,
    },
  );
});

test("resolvePmdbTarget resolves movies and series", async () => {
  assert.deepEqual(await resolvePmdbTarget("tmdb:movie:603", "movie"), {
    tmdb_id: 603,
    media_type: "movie",
  });

  assert.deepEqual(await resolvePmdbTarget("tt0133093", "movie"), {
    id_type: "imdb",
    id_value: "tt0133093",
    media_type: "movie",
  });

  assert.deepEqual(await resolvePmdbTarget("mal:21", "series"), {
    id_type: "mal",
    id_value: "21",
    media_type: "tv",
  });
});
