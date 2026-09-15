import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAnchor, rankCandidates, releaseScore } from "../src/picker";
import type { OsSubtitle } from "../src/opensubtitles/types";
import { decodeRef, encodeRef, slugify } from "../src/urls";
import { parseVideoId } from "../src/addon";
import { decodeConfig, encodeConfig, resolveConfig } from "../src/config";

function sub(overrides: Partial<OsSubtitle> = {}): OsSubtitle {
  return {
    subtitleId: "1",
    fileId: 1,
    fileName: "x.srt",
    language: "en",
    release: "",
    downloadCount: 100,
    ratings: 0,
    fps: null,
    hearingImpaired: false,
    aiTranslated: false,
    machineTranslated: false,
    fromTrusted: false,
    moviehashMatch: false,
    ...overrides,
  };
}

test("a hash match always wins the anchor slot", () => {
  const all = [
    sub({ fileId: 1, language: "en", downloadCount: 900_000 }),
    sub({ fileId: 2, language: "pl", downloadCount: 5, moviehashMatch: true }),
  ];
  const anchor = pickAnchor(all, ["en", "pl"], "some.file.mkv");
  assert.equal(anchor?.subtitle.fileId, 2);
  assert.equal(anchor?.tier, "hash");
});

test("among hash matches, the preferred anchor language comes first", () => {
  const all = [
    sub({ fileId: 1, language: "pl", moviehashMatch: true, downloadCount: 999 }),
    sub({ fileId: 2, language: "en", moviehashMatch: true, downloadCount: 1 }),
  ];
  assert.equal(pickAnchor(all, ["en", "pl"], undefined)?.subtitle.fileId, 2);
  assert.equal(pickAnchor(all, ["pl", "en"], undefined)?.subtitle.fileId, 1);
});

test("a clean transcript is preferred over a hearing-impaired one", () => {
  const all = [
    sub({ fileId: 1, language: "en", moviehashMatch: true, hearingImpaired: true }),
    sub({ fileId: 2, language: "en", moviehashMatch: true, hearingImpaired: false }),
  ];
  assert.equal(pickAnchor(all, ["en"], undefined)?.subtitle.fileId, 2);
});

test("with no hash match, a close release name is a weaker anchor", () => {
  const filename = "John.Wick.Chapter.4.2023.1080p.BluRay.x264-SPARKS.mkv";
  const all = [
    sub({ fileId: 1, release: "Some.Other.Movie.2019.720p.WEB-GROUP" }),
    sub({ fileId: 2, release: "John.Wick.Chapter.4.2023.1080p.BluRay.x264-SPARKS" }),
  ];
  const anchor = pickAnchor(all, ["en"], filename);
  assert.equal(anchor?.subtitle.fileId, 2);
  assert.equal(anchor?.tier, "release");
});

test("no hash match and no similar release means no anchor at all", () => {
  const all = [sub({ fileId: 1, release: "Completely.Different.2001.DVDRip" })];
  assert.equal(pickAnchor(all, ["en"], "John.Wick.Chapter.4.2023.1080p.mkv"), null);
});

test("release score rewards a matching release group", () => {
  const filename = "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLUX.mkv";
  const same = releaseScore(filename, "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-FLUX");
  const other = releaseScore(filename, "Dune.Part.Two.2024.1080p.BluRay.x264-SPARKS");
  const wrong = releaseScore(filename, "The.Godfather.1972.1080p.BluRay.x264-AMIABLE");

  assert.ok(same > other, `same=${same} other=${other}`);
  assert.ok(other > wrong, `other=${other} wrong=${wrong}`);
  assert.ok(same >= 0.9 && wrong < 0.25);
});

test("machine translations sink to the bottom of the ranking", () => {
  const ranked = rankCandidates([
    sub({ fileId: 1, downloadCount: 50_000, machineTranslated: true }),
    sub({ fileId: 2, downloadCount: 500, fromTrusted: true }),
  ]);
  assert.equal(ranked[0]!.fileId, 2);
});

test("video ids parse into a movie or an episode", () => {
  assert.deepEqual(parseVideoId("tt10366206"), { type: "movie", imdbId: 10366206 });
  assert.deepEqual(parseVideoId("tt0944947:3:9"), {
    type: "episode",
    imdbId: 944947,
    season: 3,
    episode: 9,
  });
  assert.equal(parseVideoId("kitsu:12345"), null);
});

test("file references survive the round trip through a URL segment", () => {
  assert.deepEqual(decodeRef(encodeRef({ fileId: 987, lang: "pt-br" })), {
    fileId: 987,
    lang: "pt-br",
  });
  assert.equal(decodeRef("nonsense"), null);
  assert.equal(decodeRef("0.en"), null);
  assert.equal(decodeRef(undefined), null);
});

test("slugs are safe and never empty", () => {
  assert.equal(slugify("John.Wick.Chapter.4.2023.mkv"), "john-wick-chapter-4-2023");
  assert.equal(slugify("???"), "subtitle");
  assert.ok(slugify("x".repeat(200)).length <= 60);
});

test("only user-supplied settings go into the URL token", () => {
  assert.equal(encodeConfig(undefined), "_");
  assert.equal(encodeConfig({}), "_");
  assert.equal(encodeConfig({ osApiKey: "" }), "_");

  const token = encodeConfig({ osApiKey: "abc", languages: "pl,en" });
  assert.notEqual(token, "_");
  assert.deepEqual(decodeConfig(token), { osApiKey: "abc", languages: "pl,en" });
  // A damaged token falls back to the environment rather than throwing.
  assert.equal(decodeConfig("!!!not-base64!!!"), undefined);
});

test("user settings override the environment, which fills the rest", () => {
  process.env.LANGUAGES = "de";
  process.env.OS_API_KEY = "from-env";

  const fromEnv = resolveConfig(undefined);
  assert.deepEqual(fromEnv.languages, ["de"]);
  assert.equal(fromEnv.osApiKey, "from-env");

  const fromUser = resolveConfig({ languages: "pl, en", osApiKey: "from-user" });
  assert.deepEqual(fromUser.languages, ["pl", "en"]);
  assert.equal(fromUser.osApiKey, "from-user");

  assert.equal(resolveConfig({ maxPerLang: "999" }).maxPerLang, 20);
  assert.equal(resolveConfig({ format: "vtt" }).format, "vtt");
  assert.equal(resolveConfig({ format: "nonsense" }).format, "srt");

  delete process.env.LANGUAGES;
  delete process.env.OS_API_KEY;
});

test("blank fields from the install form leave the environment values in place", () => {
  process.env.OS_API_KEY = "from-env";
  process.env.TORBOX_API_KEY = "torbox-from-env";
  process.env.MAX_PER_LANG = "7";
  try {
    // What the SDK's install button sends for fields left empty.
    const config = resolveConfig({
      osApiKey: "",
      osUsername: "",
      osPassword: "",
      torboxApiKey: " ",
      maxPerLang: "",
      labels: "",
      languages: "pl",
    });
    assert.equal(config.osApiKey, "from-env");
    assert.equal(config.osUsername, undefined);
    assert.equal(config.torboxApiKey, "torbox-from-env");
    assert.equal(config.maxPerLang, 7);
    assert.equal(config.verboseLabels, false);
    // A field that was filled in still wins.
    assert.deepEqual(config.languages, ["pl"]);
  } finally {
    delete process.env.OS_API_KEY;
    delete process.env.TORBOX_API_KEY;
    delete process.env.MAX_PER_LANG;
  }
});
