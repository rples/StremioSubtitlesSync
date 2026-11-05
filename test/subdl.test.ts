import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SubdlClient, SubdlError } from "../src/subdl/client";
import { validSubdlFileId } from "../src/subdl/reference";
import { subdlLanguage } from "../src/subdl/languages";
import { decodeRef, encodeRef } from "../src/urls";
import type { SearchQuery } from "../src/opensubtitles/types";

const MOVIE: SearchQuery = { type: "movie", imdbId: 1234567, languages: ["nl"] };
const EPISODE: SearchQuery = { ...MOVIE, type: "episode", season: 2, episode: 3 };
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nEigen testregel.\n";
const json = (value: unknown): Response => Response.json(value);
function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "Owned.S02E03.srt", release_name: "Owned.WEB", season: 2, episode: 3,
    language: "Dutch", format: "srt", url: "https://dl.subdl.com/subtitle/parent/child?api_key=DO-NOT-RETAIN", ...overrides };
}
function body(items: unknown[], query = MOVIE, extra: Record<string, unknown> = {}): unknown {
  return { status: true, results: [{ imdb_id: "tt1234567", type: query.type === "movie" ? "movie" : "tv" }],
    subtitles: items, totalPages: 1, ...extra };
}
function client(transport: typeof fetch, apiKey = randomUUID()): SubdlClient {
  return new SubdlClient({ apiKey, fetch: transport });
}

test("SubDL maps language names and codes without passing unknown names as ISO", () => {
  for (const name of ["Dutch", "NL", "dut", "nld"]) assert.equal(subdlLanguage(name), "nl");
  assert.equal(subdlLanguage("Brazilian Portuguese"), "pt-br");
  assert.equal(subdlLanguage("English"), "en");
  assert.equal(subdlLanguage("not-a-language"), undefined);
});

test("provider references are namespaced, backward compatible and reject paths", () => {
  const ref = { provider: "subdl" as const, fileId: "parent~child", lang: "nl" };
  assert.deepEqual(decodeRef(encodeRef(ref)), ref);
  assert.deepEqual(decodeRef("123.en"), { fileId: 123, lang: "en" });
  for (const bad of ["subdl~../secret.nl", "subdl~a~b~c.nl", "subdl~.nl", "subdl~https://x.nl"]) {
    assert.equal(decodeRef(bad), null);
  }
});

test("movie search uses header auth, unpacking and safe IDs; never hash-match metadata", async () => {
  const c = client(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("imdb_id"), "tt1234567");
    assert.equal(url.searchParams.get("unpack"), "1");
    assert.equal(url.searchParams.has("api_key"), false);
    assert.equal(url.searchParams.has("moviehash"), false);
    assert.ok(new Headers(init?.headers).get("Authorization")?.startsWith("Bearer "));
    assert.equal(init?.redirect, "error");
    return json(body([{ moviehash_match: true, hi: true, unpack_files: [file()] }]));
  });
  const found = await c.search({ ...MOVIE, moviehash: "0123456789abcdef" });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.fileId, "parent~child");
  assert.equal(found[0]?.moviehashMatch, false);
  assert.equal(found[0]?.hearingImpaired, true);
  assert.ok(!JSON.stringify(found).includes("DO-NOT-RETAIN"));
});

test("season pack only offers the explicit requested episode, language and supported format", async () => {
  const c = client(async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("type"), "tv");
    assert.equal(url.searchParams.get("season"), "2");
    assert.equal(url.searchParams.get("episode"), "3");
    return json(body([{ full_season: true, unpack_files: [file(), file({ episode: 4 }),
      file({ season: 1 }), file({ episode: undefined }), file({ language: "English" }),
      file({ format: "sub" }), file({ url: "https://evil.invalid/subtitle/parent/child" }),
      file({ url: "https://dl.subdl.com.evil.invalid/subtitle/parent/child" })] }], EPISODE));
  });
  assert.equal((await c.search(EPISODE)).length, 1);
});

test("ambiguous pack without unpack files is skipped, explicit single-file episode is supported", async () => {
  const c = client(async () => json(body([
    { n_id: "pack", full_season: true, lang: "nl", season: 2, episode: 3 },
    { n_id: "range", lang: "nl", season: 2, episode: 3, episode_from: 3, episode_end: 6 },
    { n_id: "single", lang: "nl", season: 2, episode: 3 },
  ], EPISODE)));
  assert.deepEqual((await c.search(EPISODE)).map(s => s.fileId), ["single"]);
});

test("title identity mismatch is rejected, but an empty successful result is valid", async () => {
  await assert.rejects(client(async () => json(body([{ unpack_files: [file()] }], MOVIE,
    { results: [{ imdb_id: "tt9999999", type: "movie" }] }))).search(MOVIE), /different title/);
  assert.deepEqual(await client(async () => json({ status: true, results: [], subtitles: [] })).search(MOVIE), []);
});

test("search pagination is capped and duplicate files are collapsed", async () => {
  let calls = 0;
  const c = client(async () => { calls++; return json(body([{ unpack_files: [file()] }], MOVIE, { totalPages: 99 })); });
  assert.equal((await c.search(MOVIE)).length, 1);
  assert.equal(calls, 3);
  await c.search({ ...MOVIE, moviehash: "another-file" });
  assert.equal(calls, 3, "video hashes do not spend new SubDL search quota for the same query");
});

test("exact unpacked file is fetched with header auth; repeated/concurrent downloads share quota", async () => {
  let calls = 0;
  const c = client(async (input, init) => {
    calls++;
    assert.equal(String(input), "https://dl.subdl.com/subtitle/parent/child");
    assert.ok(new Headers(init?.headers).get("X-API-Key"));
    return new Response(SRT);
  });
  assert.deepEqual(await Promise.all([c.fetchFile("parent~child", "nl"), c.fetchFile("parent~child", "nl")]), [SRT, SRT]);
  assert.equal(await c.fetchFile("parent~child", "nl"), SRT);
  assert.equal(calls, 1);
});

test("single-file v2 download and account-separated download cache", async () => {
  let calls = 0;
  const transport: typeof fetch = async (input) => {
    calls++;
    assert.equal(String(input), "https://api.subdl.com/api/v2/subtitles/single/download?format=file");
    return new Response(SRT);
  };
  await client(transport).fetchFile("single", "nl");
  await client(transport).fetchFile("single", "nl");
  assert.equal(calls, 2);
});

for (const status of [401, 403, 406, 429]) {
  test(`HTTP ${status} stops account retries and never echoes key-bearing error bodies`, async () => {
    let calls = 0;
    const c = client(async () => { calls++; return new Response("SECRET api_key=DO-NOT-RETAIN", { status, headers: { "Retry-After": "120" } }); });
    await assert.rejects(c.search(MOVIE), (e: unknown) => e instanceof SubdlError && e.status === status && e.retryAfterSeconds === 120 && !e.message.includes("SECRET"));
    await assert.rejects(c.search(MOVIE), /cooling down/);
    assert.equal(calls, 1);
  });
}

test("failed search application response is not cached as success or repeatedly hammered", async () => {
  let calls = 0;
  const c = client(async () => { calls++; return json({ status: false, error: "SECRET" }); });
  await assert.rejects(c.search(MOVIE), /rejected/);
  await assert.rejects(c.search(MOVIE), /cooling down/);
  assert.equal(calls, 1);
});

test("streamed and declared response size caps cancel the response", async () => {
  await assert.rejects(client(async () => new Response("small", { headers: { "Content-Length": String(5 * 1024 * 1024) } })).search(MOVIE), /size limit/);
  let cancelled = false;
  const c = client(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(c.fetchFile("large", "nl"), /size limit/);
  assert.equal(cancelled, true);
});

test("zip, binary, HTML and invalid cues never enter the successful file cache", async () => {
  for (const value of ["PK-archive", "binary\0data", "<html>login</html>", "1\n00:00:02,000 --> 00:00:01,000\nbad\n"]) {
    let calls = 0;
    const c = client(async () => { calls++; return new Response(value); });
    await assert.rejects(c.fetchFile("badfile", "nl"));
    await assert.rejects(c.fetchFile("badfile", "nl"));
    assert.equal(calls, 2);
  }
});

test("network and redirect errors have safe messages; invalid references do not make requests", async () => {
  let calls = 0;
  const c = client(async () => { calls++; throw new Error("redirect SECRET https://evil.invalid/key"); });
  await assert.rejects(c.fetchFile("valid", "nl"), /^SubdlError: SubDL request failed or timed out$/);
  await assert.rejects(c.fetchFile("../invalid", "nl"), /Bad SubDL file/);
  assert.equal(calls, 1);
});
