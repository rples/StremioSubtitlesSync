import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { OpenSubtitlesClient } from "../src/opensubtitles/client";
import { TorBoxSource } from "../src/sources/torbox";

test("OpenSubtitles search and downloads never use another account's cache", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const key = new Headers(init?.headers).get("Api-Key") ?? "";
    requests.push(`${url.pathname}:${key}`);
    if (url.pathname.endsWith("/subtitles")) return Response.json({ data: [] });
    if (url.pathname.endsWith("/download")) return Response.json({ link: "https://owned.invalid/file" });
    assert.equal(url.hostname, "owned.invalid");
    return new Response("1\n00:00:01,000 --> 00:00:02,000\nOwned subtitle\n");
  };
  try {
    const a = new OpenSubtitlesClient({ apiKey: randomUUID() });
    const b = new OpenSubtitlesClient({ apiKey: randomUUID() });
    const query = { type: "movie" as const, imdbId: 1234567, languages: ["nl"] };
    await a.search(query); await b.search(query); await a.search(query);
    assert.equal(requests.filter((value) => value.includes("/subtitles:")).length, 2);
    await a.fetchFile(123456, "nl"); await b.fetchFile(123456, "nl"); await a.fetchFile(123456, "nl");
    assert.equal(requests.filter((value) => value.includes("/download:")).length, 2);
  } finally { globalThis.fetch = original; }
});

test("OpenSubtitles errors never echo a provider body containing keys", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("PRIVATE-API-KEY", { status: 403 });
  try {
    await assert.rejects(new OpenSubtitlesClient({ apiKey: randomUUID() }).search({ type: "movie", imdbId: 1, languages: ["nl"] }),
      { message: "OpenSubtitles returned HTTP 403" });
  } finally { globalThis.fetch = original; }
});

test("TorBox account lists and signed download links are isolated even with equal key suffixes and file IDs", async () => {
  const original = globalThis.fetch;
  const prefix = randomUUID();
  const keys = [`${prefix}-A-SAME-END`, `${prefix}-B-SAME-END`];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/requestdl")) {
      assert.equal(init?.redirect, "error");
      return Response.json({ data: `https://owned.invalid/${url.searchParams.get("token") === keys[0] ? "A" : "B"}` });
    }
    const key = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
    if (!url.pathname.endsWith("/torrents/mylist")) return Response.json({ data: [] });
    return Response.json({ data: [{ id: 99, files: [{ id: 1, short_name: `${key === keys[0] ? "A" : "B"}.mkv`, size: 100_000_000, opensubtitles_hash: "0123456789abcdef" }] }] });
  };
  try {
    const a = await new TorBoxSource(keys[0]!).resolve({ videoHash: "0123456789abcdef", videoSize: 100_000_000, filename: undefined });
    const b = await new TorBoxSource(keys[1]!).resolve({ videoHash: "0123456789abcdef", videoSize: 100_000_000, filename: undefined });
    assert.equal(a[0]?.name, "A.mkv"); assert.equal(a[0]?.url, "https://owned.invalid/A");
    assert.equal(b[0]?.name, "B.mkv"); assert.equal(b[0]?.url, "https://owned.invalid/B");
  } finally { globalThis.fetch = original; }
});
