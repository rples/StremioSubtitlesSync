import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { getRouter } from "stremio-addon-sdk";
import { randomUUID } from "node:crypto";
import { toSrt } from "../src/subtitles/serialize";
import { parseSubtitle } from "../src/subtitles/parse";
import { translationRoutes } from "../src/translation/routes";
import { credentialRoutes } from "../src/credentials/routes";
import { runWithRequest } from "../src/context";
import { translationUrl } from "../src/translation/source";
import type { Cue } from "../src/subtitles/types";

const realFetch = globalThis.fetch;
const env = { ...process.env };
let server: http.Server;
let origin: string;
let aiCalls = 0;
let downloadCalls = 0;
let aiStatus = 200;
let expectedPersonalAiKey: string | undefined;
const reference: Cue[] = [];
let time = 20000;
for (let i = 0; i < 120; i++) {
  const duration = 1200 + i * 617 % 2300;
  reference.push({ start: time, end: time + duration, text: `Owned English fixture ${i}` });
  time += duration + 500 + i * 331 % 3900;
}
function candidate(id: number, language: string, exact: boolean): unknown {
  return { id: String(id), attributes: { language, moviehash_match: exact, files: [{ file_id: id }], release: "Owned fixture" } };
}
before(async () => {
  process.env.CREDENTIAL_MODE = "server";
  process.env.OS_API_KEY = "owned-os-fixture";
  process.env.AI_ENABLED = "true";
  process.env.AI_BASE_URL = "https://owned-ai.invalid/v1";
  process.env.AI_API_KEY = randomUUID();
  process.env.AI_MODEL = "owned-model";
  process.env.LANGUAGES = "nl";
  process.env.ANCHOR_LANGUAGES = "es";
  process.env.AI_SOURCE_LANGUAGES = "en";
  delete process.env.SUBDL_API_KEY;
  delete process.env.TORBOX_API_KEY;
  delete process.env.BASE_URL;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.opensubtitles.com") {
      if (url.pathname.endsWith("/subtitles")) {
        const id = url.searchParams.get("imdb_id");
        const data = id === "1000003" ? [candidate(400, "nl", true), candidate(100, "en", true)]
          : id === "1000002" ? [candidate(300, "es", true), candidate(200, "en", false)]
          : id === "1000004" ? [candidate(200, "en", false)] : [candidate(100, "en", true)];
        return Response.json({ data });
      }
      if (url.pathname.endsWith("/download")) {
        downloadCalls++;
        return Response.json({ link: `https://owned-files.invalid/${JSON.parse(String(init?.body)).file_id}` });
      }
    }
    if (url.hostname === "owned-files.invalid") {
      const id = Number(url.pathname.slice(1));
      if (id === 999) return new Response("Unavailable fixture", { status: 404 });
      return new Response(toSrt(reference.map((cue) => ({ ...cue,
        start: id === 500 ? 0 : cue.start + (id === 200 ? 3500 : 0), end: id === 500 ? 100000 : cue.end + (id === 200 ? 3500 : 0),
        text: id === 400 ? "Eigen Nederlandse testregel" : cue.text,
      }))));
    }
    if (url.hostname === "owned-ai.invalid") {
      aiCalls++;
      assert.equal(url.pathname, "/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${expectedPersonalAiKey ?? process.env.AI_API_KEY}`);
      if (aiStatus !== 200) return new Response("PRIVATE provider body", { status: aiStatus, headers: { "Retry-After": "22" } });
      const body = JSON.parse(String(init?.body));
      if (expectedPersonalAiKey) assert.equal(body.model, "owned-personal-model");
      const request = JSON.parse(body.messages[1].content);
      assert.equal(request.target_language, "nl");
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        cues: request.cues.map((cue: { id: number }) => ({ id: cue.id, text: `Eigen vertaling ${cue.id}` })),
      }) } }] });
    }
    if (url.hostname !== "127.0.0.1") throw new Error("Unexpected external request in fixture");
    return realFetch(input, init);
  };
  const { addonInterface } = await import("../src/addon.js");
  const app = express();
  app.use((req, _res, next) => runWithRequest(req, next));
  app.use(credentialRoutes());
  app.use(translationRoutes());
  app.use(getRouter(addonInterface));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
});
interface Entry { id: string; lang: string; url: string }
async function listing(id: number): Promise<Entry[]> {
  const response = await fetch(`${origin}/subtitles/movie/tt${id}/videoHash=0123456789abcdef.json`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { subtitles: Entry[] }).subtitles;
}

test("listing offers a visibly labelled AI fallback without downloading or calling AI", async () => {
  const calls = aiCalls;
  const downloads = downloadCalls;
  const list = await listing(1000001);
  assert.equal(list.length, 1);
  assert.ok(list[0]!.id.startsWith("ai-nl-"));
  assert.match(list[0]!.lang, /Dutch - AI translation from English \(exact match\)/);
  assert.equal(aiCalls, calls);
  assert.equal(downloadCalls, downloads);
  assert.ok(!list[0]!.url.includes(process.env.AI_API_KEY!));
  assert.ok(!list[0]!.url.includes("owned-ai.invalid"));
});

test("selected translation is returned as Dutch SRT with exactly inherited timing and reused text", async () => {
  const entry = (await listing(1000001))[0]!;
  const calls = aiCalls;
  const response = await fetch(entry.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-subtitle-translation") ?? "", /AI/);
  assert.equal(response.headers.get("x-subtitle-sync"), "exact");
  const translated = parseSubtitle(await response.text());
  assert.equal(translated.length, reference.length);
  assert.equal(translated[0]!.text, "Eigen vertaling 1");
  assert.deepEqual(translated.map(({ start, end }) => [start, end]), reference.map(({ start, end }) => [start, end]));
  assert.equal(aiCalls - calls, 4, "120 cues use four bounded batches");
  assert.equal((await fetch(entry.url)).status, 200);
  assert.equal(aiCalls - calls, 4);
});

test("a native Dutch candidate suppresses AI fallback even with AI enabled", async () => {
  const calls = aiCalls;
  const list = await listing(1000003);
  assert.equal(list.length, 1);
  assert.ok(!list[0]!.id.startsWith("ai-"));
  assert.equal(aiCalls, calls);
});

test("source timing is corrected before translation; identical text does not reimpose old timing", async () => {
  const calls = aiCalls;
  const entry = (await listing(1000002))[0]!;
  assert.match(entry.lang, /auto-synced/);
  const response = await fetch(entry.url);
  assert.equal(response.status, 200);
  const translated = parseSubtitle(await response.text());
  for (let i = 0; i < translated.length; i++) assert.ok(Math.abs(translated[i]!.start - reference[i]!.start) <= 40);
  assert.equal(aiCalls, calls, "same source text reuses translation after independent alignment");
});

test("no timing reference means no automatic translation candidate by default", async () => {
  assert.deepEqual(await listing(1000004), []);
});

test("unavailable alignment anchor causes no paid AI request or wrong-language fallback", async () => {
  const url = translationUrl(origin, "_", `${origin}/_/x/999.es/200.en/test.srt`, "nl", "synced", "test", "srt");
  const calls = aiCalls;
  const response = await fetch(url);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Translation source is unavailable");
  assert.equal(aiCalls, calls);
});

test("unconfident timing is refused before any translation charge", async () => {
  const url = translationUrl(origin, "_", `${origin}/_/x/300.es/500.en/test.srt`, "nl", "synced", "test", "srt");
  const calls = aiCalls;
  const response = await fetch(url);
  assert.equal(response.status, 503);
  assert.match(await response.text(), /could not be confidently aligned/);
  assert.equal(aiCalls, calls);
});

test("disabled AI, unconfigured targets and forbidden source operations fail before AI calls", async () => {
  const entry = (await listing(1000001))[0]!;
  const calls = aiCalls;
  assert.equal((await fetch(entry.url.replace("/t/nl/", "/t/fr/"))).status, 400);
  const bad = Buffer.from(JSON.stringify({ path: "https://internal.invalid", timing: "exact" })).toString("base64url");
  assert.equal((await fetch(`${origin}/_/t/nl/${bad}/test.srt`)).status, 400);
  delete process.env.AI_ENABLED;
  try {
    assert.equal((await fetch(entry.url)).status, 403);
    assert.deepEqual(await listing(1000001), []);
    assert.equal(aiCalls, calls);
  } finally { process.env.AI_ENABLED = "true"; }
});

test("personal AI installation uses its own account/model and revocation blocks completed translations", async () => {
  const fields = ["CREDENTIAL_MODE", "PROFILE_DIR", "PROFILE_ENCRYPTION_KEY", "PROFILE_ENCRYPTION_KEY_FILE", "AI_ALLOWED_BASE_URLS"];
  const saved = fields.map((name) => process.env[name]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "subsync-personal-ai-"));
  try {
    process.env.CREDENTIAL_MODE = "user";
    process.env.PROFILE_DIR = directory;
    process.env.PROFILE_ENCRYPTION_KEY = "ab".repeat(32);
    delete process.env.PROFILE_ENCRYPTION_KEY_FILE;
    process.env.AI_ALLOWED_BASE_URLS = "https://owned-ai.invalid/v1";
    expectedPersonalAiKey = "owned-personal-ai-key";
    const response = await fetch(origin + "/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      osApiKey: "owned-personal-os-key", languages: "nl", aiEnabled: "true", aiBaseUrl: "https://owned-ai.invalid/v1",
      aiModel: "owned-personal-model", aiApiKey: expectedPersonalAiKey,
    }) });
    assert.equal(response.status, 201);
    const profile = await response.json() as { profile: string; manifestUrl: string };
    const list = await fetch(profile.manifestUrl.replace("manifest.json", "subtitles/movie/tt1000001/videoHash=0123456789abcdef.json"));
    assert.equal(list.status, 200);
    const entries = (await list.json()) as { subtitles: Entry[] };
    assert.equal(entries.subtitles.length, 1);
    const calls = aiCalls;
    const translated = await fetch(entries.subtitles[0]!.url);
    assert.equal(translated.status, 200);
    assert.equal(translated.headers.get("cache-control"), "private, no-store");
    assert.equal(parseSubtitle(await translated.text()).length, reference.length);
    assert.equal(aiCalls - calls, 4);
    assert.equal((await fetch(origin + "/profiles/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: profile.profile }) })).status, 204);
    assert.equal((await fetch(entries.subtitles[0]!.url)).status, 401);
    assert.equal(aiCalls - calls, 4);
  } finally {
    expectedPersonalAiKey = undefined;
    fields.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index];
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("provider quota failure is safe, retryable and does not serve a partial translation", async () => {
  process.env.AI_API_KEY = randomUUID();
  aiStatus = 429;
  const entry = (await listing(1000001))[0]!;
  const calls = aiCalls;
  const response = await fetch(entry.url);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "22");
  assert.equal(await response.text(), "AI returned HTTP 429");
  assert.equal(aiCalls - calls, 1);
  const second = await fetch(entry.url);
  assert.equal(second.status, 429);
  assert.equal(aiCalls - calls, 1);
});
