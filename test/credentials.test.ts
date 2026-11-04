import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { getRouter } from "stremio-addon-sdk";
import { credentialMode, createProfile, parseProfile, readProfile, revokeProfile, validateProfileStore } from "../src/credentials/store";
import { resolveConfig, encodeConfig, decodeConfig } from "../src/config";
import { credentialRoutes } from "../src/credentials/routes";
import { runWithRequest } from "../src/context";
import { subtitleRoutes } from "../src/routes/subtitles";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsync-profiles-"));
const env = { ...process.env };
let server: http.Server;
let origin: string;
const own = { subdlApiKey: "owned-subdl-fixture", torboxApiKey: "owned-torbox-fixture", languages: "nl" };

before(async () => {
  process.env.PROFILE_DIR = dir;
  process.env.PROFILE_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  delete process.env.PROFILE_ENCRYPTION_KEY_FILE;
  process.env.CREDENTIAL_MODE = "server";
  process.env.OS_API_KEY = "administrator-os-fixture";
  process.env.SUBDL_API_KEY = "administrator-subdl-fixture";
  process.env.TORBOX_API_KEY = "administrator-torbox-fixture";
  delete process.env.BASE_URL;
  const { addonInterface } = await import("../src/addon.js");
  const app = express();
  // Trust headers only on this loopback test server, as for an HTTPS proxy.
  app.set("trust proxy", "loopback");
  app.use((req, _res, next) => runWithRequest(req, next));
  app.use(credentialRoutes());
  app.use(subtitleRoutes());
  app.use(getRouter(addonInterface));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
});
function userMode(): void { process.env.CREDENTIAL_MODE = "user"; }
async function post(route: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(origin + route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("only two policies; invalid configuration fails closed", () => {
  delete process.env.CREDENTIAL_MODE;
  assert.equal(credentialMode(), "server");
  process.env.CREDENTIAL_MODE = "hybrid";
  assert.throws(credentialMode, /must be server or user/);
  process.env.CREDENTIAL_MODE = "server";
});

test("server mode ignores every client credential and disables personal registration", async () => {
  const config = resolveConfig({ osApiKey: "client", torboxApiKey: "client" });
  assert.equal(config.osApiKey, "administrator-os-fixture");
  assert.equal(config.subdlApiKey, "administrator-subdl-fixture");
  assert.equal(config.torboxApiKey, "administrator-torbox-fixture");
  assert.equal((await post("/profiles", own)).status, 403);
});

test("mandatory personal mode never falls back to any administrator account", () => {
  userMode();
  const config = resolveConfig({ osApiKey: "raw-client-key", torboxApiKey: "raw-client-key" });
  assert.equal(config.osApiKey, "");
  assert.equal(config.osUsername, undefined);
  assert.equal(config.osPassword, undefined);
  assert.equal(config.subdlApiKey, undefined);
  assert.equal(config.torboxApiKey, undefined);
  const token = createProfile(parseProfile(own));
  const resolved = resolveConfig({ profile: token });
  assert.equal(resolved.osApiKey, "");
  assert.equal(resolved.subdlApiKey, own.subdlApiKey);
  assert.equal(resolved.torboxApiKey, own.torboxApiKey);
  assert.deepEqual(resolved.languages, ["nl"]);
});

test("encrypted profiles survive reload, contain no plaintext keys, and authenticate tampering", () => {
  userMode();
  const token = createProfile(parseProfile(own));
  assert.deepEqual(readProfile(token), own);
  const reopened = execFileSync(process.execPath, ["--import", "tsx", "-e",
    "const {readProfile}=require('./src/credentials/store.ts'); process.stdout.write(String(!!readProfile(process.env.TEST_PROFILE_TOKEN)))"],
    { env: { ...process.env, TEST_PROFILE_TOKEN: token }, encoding: "utf8" });
  assert.equal(reopened, "true", "a fresh process must recover the profile");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  for (const name of files) {
    const body = fs.readFileSync(path.join(dir, name), "utf8");
    assert.ok(!body.includes(own.subdlApiKey));
    assert.ok(!body.includes(token));
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
  }
  const savedKey = process.env.PROFILE_ENCRYPTION_KEY;
  process.env.PROFILE_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  assert.equal(readProfile(token), undefined);
  process.env.PROFILE_ENCRYPTION_KEY = savedKey;
  assert.deepEqual(readProfile(token), own);
    // All profiles must fail safe even when ciphertext is corrupt.
  for (const name of files) fs.writeFileSync(path.join(dir, name), '{"version":1,"data":"tampered"}');
  assert.equal(readProfile(token), undefined);
});

test("encrypted files are bound to their profile identity and cannot be swapped", () => {
  const a = createProfile(parseProfile(own));
  const b = createProfile(parseProfile({ subdlApiKey: "different-owned-fixture" }));
  const file = (token: string) => path.join(dir, createHash("sha256").update(token).digest("hex") + ".json");
  fs.copyFileSync(file(b), file(a));
  assert.equal(readProfile(a), undefined);
  assert.equal(readProfile(b)?.subdlApiKey, "different-owned-fixture");
});

test("encryption key may come from a mounted secret; invalid or missing keys fail startup validation", () => {
  const saved = process.env.PROFILE_ENCRYPTION_KEY;
  delete process.env.PROFILE_ENCRYPTION_KEY;
  assert.throws(validateProfileStore, /persistent 32-byte/);
  const file = path.join(dir, "mounted-secret");
  fs.writeFileSync(file, saved! + "\n");
  process.env.PROFILE_ENCRYPTION_KEY_FILE = file;
  assert.doesNotThrow(validateProfileStore);
  delete process.env.PROFILE_ENCRYPTION_KEY_FILE;
  process.env.PROFILE_ENCRYPTION_KEY = saved;
});

test("profile validation rejects unknown fields and requires a personal subtitle provider", () => {
  for (const value of [null, [], { torboxApiKey: "only-torbox" }, { ...own, endpoint: "http://internal" }, { subdlApiKey: 12 }]) {
    assert.throws(() => parseProfile(value));
  }
  assert.throws(() => parseProfile({ subdlApiKey: "x".repeat(8193) }));
});

test("generated URLs strip credentials, while retaining the opaque profile reference", () => {
  const encoded = encodeConfig({ osApiKey: "secret", osPassword: "secret", torboxApiKey: "secret", profile: "opaque", languages: "nl" });
  assert.deepEqual(decodeConfig(encoded), { profile: "opaque", languages: "nl" });
  assert.ok(!Buffer.from(encoded, "base64url").toString().includes("secret"));
});

test("HTTPS registration returns no key, raw-key URLs are rejected, and setup HTML does not echo profiles", async () => {
  userMode();
  const response = await post("/profiles", own);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as { profile: string; manifestUrl: string };
  assert.deepEqual(readProfile(body.profile), own);
  assert.ok(!JSON.stringify(body).includes(own.subdlApiKey));
  assert.equal((await fetch(body.manifestUrl)).status, 200);
  const legacy = encodeURIComponent(JSON.stringify({ osApiKey: "never-accept-this" }));
  assert.equal((await fetch(`${origin}/${legacy}/manifest.json`)).status, 400);
  const html = await (await fetch(`${origin}/configure`)).text();
  assert.ok(html.includes('type="password"'));
  assert.ok(!html.includes(body.profile));
  assert.ok(!html.includes(own.subdlApiKey));
});

test("registration refuses cross-origin, non-HTTPS remote hosts, invalid JSON and oversized bodies", async () => {
  assert.equal((await post("/profiles", own, { Origin: "https://evil.invalid" })).status, 403);
  assert.equal((await post("/profiles", own, { "X-Forwarded-Host": "public.invalid" })).status, 400);
  const malformed = await fetch(origin + "/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"subdlApiKey":"SECRET"' });
  assert.equal(malformed.status, 400);
  assert.ok(!(await malformed.text()).includes("SECRET"));
  assert.equal((await post("/profiles", { subdlApiKey: "x".repeat(40 * 1024) })).status, 400);
});

test("trusted HTTPS proxy origin is used for personal setup; plain remote setup is refused", async () => {
  const response = await post("/profiles", own, {
    "X-Forwarded-Proto": "https", "X-Forwarded-Host": "subs.example.test", Origin: "https://subs.example.test",
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { manifestUrl: string };
  assert.ok(body.manifestUrl.startsWith("https://subs.example.test/"));
  assert.equal((await fetch(origin + "/configure", { headers: { "X-Forwarded-Host": "subs.example.test" } })).status, 400);
});

test("revocation denies cached subtitle responses and never falls back to host keys", async () => {
  const token = createProfile(parseProfile(own));
  const cfg = encodeConfig({ profile: token });
  const originalFetch = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).hostname === "dl.subdl.com") {
      downloads++;
      assert.equal(new Headers(init?.headers).get("X-API-Key"), own.subdlApiKey);
      return new Response("1\n00:00:01,000 --> 00:00:02,000\nOwned fixture\n");
    }
    return originalFetch(input, init);
  };
  try {
    const url = `${origin}/${cfg}/s/subdl~personal~fixture.nl/test.srt`;
    const served = await fetch(url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("cache-control"), "private, no-store");
    assert.equal(downloads, 1);
    assert.equal((await post("/profiles/revoke", { profile: token })).status, 204);
    assert.equal((await fetch(url)).status, 401);
    assert.equal(downloads, 1);
    assert.equal(resolveConfig({ profile: token }).subdlApiKey, undefined);
    assert.equal((await fetch(`${origin}/_/s/subdl~personal~fixture.nl/test.srt`)).status, 401);
    assert.equal((await fetch(`${origin}/${encodeConfig({ profile: "../secret" })}/manifest.json`)).status, 401);
  } finally { globalThis.fetch = originalFetch; }
});

test("personal SDK resources cannot override private no-store headers", async () => {
  const token = createProfile(parseProfile(own));
  const response = await fetch(`${origin}/${encodeURIComponent(JSON.stringify({ profile: token }))}/subtitles/movie/not-an-imdb-id.json`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  revokeProfile(token);
});

test("personal setup URL works through SDK listing and subtitle delivery with only personal credentials", async () => {
  const registered = await post("/profiles", { ...own, unsynced: "true" });
  assert.equal(registered.status, 201);
  const installed = await registered.json() as { profile: string; manifestUrl: string };
  const originalFetch = globalThis.fetch;
  let searches = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.subdl.com") {
      searches++;
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${own.subdlApiKey}`);
      return Response.json({ status: true, results: [{ imdb_id: "tt7654321", type: "movie" }],
        subtitles: [{ language: "Dutch", unpack_files: [{ url: "https://dl.subdl.com/subtitle/personal/listed", format: "srt" }] }] });
    }
    if (url.hostname === "dl.subdl.com") {
      assert.equal(new Headers(init?.headers).get("x-api-key"), own.subdlApiKey);
      return new Response("1\n00:00:01,000 --> 00:00:02,000\nOwned fixture\n");
    }
    if (url.hostname !== "127.0.0.1") throw new Error("Unexpected external request");
    return originalFetch(input, init);
  };
  try {
    const response = await fetch(installed.manifestUrl.replace("manifest.json", "subtitles/movie/tt7654321.json"));
    assert.equal(response.status, 200);
    const body = await response.json() as { subtitles: { url: string }[] };
    assert.equal(searches, 1);
    assert.equal(body.subtitles.length, 1);
    assert.ok(!JSON.stringify(body).includes(own.subdlApiKey));
    assert.equal((await fetch(body.subtitles[0]!.url)).status, 200);
    revokeProfile(installed.profile);
    assert.equal((await fetch(body.subtitles[0]!.url)).status, 401);
  } finally { globalThis.fetch = originalFetch; }
});

test("registration has a global write limit even with rotating IP headers", async () => {
  for (let i = 0; i < 100; i++) {
    const response = await post("/profiles", {}, { "X-Forwarded-For": `192.0.2.${i}` });
    if (response.status === 429) {
      assert.equal(response.headers.get("retry-after"), "3600");
      return;
    }
  }
  assert.fail("global write limit did not activate");
});
