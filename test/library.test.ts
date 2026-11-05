import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TranslationLibrary, artifactIdentity, hash, type LibraryContext } from "../src/library/store";
import { translatedCues } from "../src/translation/service";
import { translationSettings, type TranslationSettings } from "../src/translation/config";
import type { Cue } from "../src/subtitles/types";

const cues: Cue[] = [{ start: 1000, end: 2500, text: "Owned source line." }, { start: 4000, end: 6000, text: "Another owned line." }];
const context: LibraryContext = { scope: "server", timing: "exact", source: { provider: "subdl", fileId: "owned~fixture", language: "en" }, videoId: "tt1234567", release: "Owned.Release.mkv" };
function settings(): TranslationSettings {
  return translationSettings({ aiEnabled: "true", aiBaseUrl: "https://owned-ai.invalid/v1", aiModel: "owned-model", aiApiKey: randomUUID() }, false)!;
}
async function fixture(run: (library: TranslationLibrary, directory: string) => Promise<void>): Promise<void> {
  const names = ["TRANSLATION_LIBRARY_DIR", "TRANSLATION_LIBRARY_MAX_BYTES", "TRANSLATION_LIBRARY_MAX_ITEMS", "AI_PROFILE_REVISION"];
  const saved = names.map((name) => process.env[name]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsync-library-"));
  process.env.TRANSLATION_LIBRARY_DIR = path.join(dir, "library");
  delete process.env.TRANSLATION_LIBRARY_MAX_BYTES;
  delete process.env.TRANSLATION_LIBRARY_MAX_ITEMS;
  delete process.env.AI_PROFILE_REVISION;
  try { await run(new TranslationLibrary(process.env.TRANSLATION_LIBRARY_DIR), dir); }
  finally {
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function transport(count: () => void): typeof fetch {
  return async (_input, init) => {
    count();
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ cues: input.cues.map((cue: { id: number }) => ({ id: cue.id, text: `Owned translation ${cue.id}` })) }) } }] });
  };
}

test("content identity excludes credentials and timing, but includes source/profile revisions", async () => fixture(async () => {
  const a = settings();
  const identity = artifactIdentity(cues, "en", "nl", a);
  assert.equal(identity.id, artifactIdentity(cues.map((cue) => ({ ...cue, start: cue.start + 1000 })), "en", "nl", { ...a, apiKey: "another-owned-key", headers: { "x-api-key": "another-secret" } }).id);
  assert.notEqual(identity.id, artifactIdentity(cues, "en", "nl", { ...a, model: "revised-model" }).id);
  assert.notEqual(identity.id, artifactIdentity(cues.map((cue) => ({ ...cue, text: cue.text + " revised" })), "en", "nl", a).id);
  assert.notEqual(identity.id, artifactIdentity(cues, "en", "de", a).id);
  process.env.AI_PROFILE_REVISION = "reviewed-routing-v2";
  assert.notEqual(identity.id, artifactIdentity(cues, "en", "nl", a).id);
}));

test("successful translation is atomically persisted and a new process reuses it without AI", async () => fixture(async (library) => {
  let calls = 0;
  const cfg = settings();
  const result = await translatedCues(cues, "en", "nl", cfg, transport(() => calls++), context);
  assert.equal(calls, 1);
  assert.equal(result[0]!.text, "Owned translation 1");
  const entries = library.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.variants.length, 1);
  const reopened = execFileSync(process.execPath, ["--import", "tsx", "-e", `
    const {translatedCues}=require('./src/translation/service.ts');
    translatedCues(JSON.parse(process.env.OWNED_CUES), 'en', 'nl', JSON.parse(process.env.OWNED_SETTINGS), async()=>{throw new Error('AI MUST NOT RUN')}, JSON.parse(process.env.OWNED_CONTEXT))
      .then(value=>process.stdout.write(JSON.stringify(value))).catch(()=>process.exit(1));
  `], { env: { ...process.env, OWNED_CUES: JSON.stringify(cues), OWNED_SETTINGS: JSON.stringify({ ...cfg, apiKey: "rotated-owned-key" }), OWNED_CONTEXT: JSON.stringify(context) }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(reopened), result);
  const artifact = library.load("server", entries[0]!.id)!;
  assert.equal(artifact.validation, "structural-only");
  assert.ok(!JSON.stringify(artifact).includes(cfg.apiKey));
  assert.ok(!JSON.stringify(artifact).includes("rotated-owned-key"));
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(library.root, "server", artifact.id, "artifact.json")).mode & 0o777, 0o600);
}));

test("explicit instance reuse shares one job across accounts and preserves independent timing", async () => fixture(async (library) => {
  let calls = 0;
  const cfg = settings();
  const shared = { ...context, scope: "instance" };
  const retimed = cues.map((cue) => ({ ...cue, start: cue.start + 9000, end: cue.end + 9000 }));
  const [a, b] = await Promise.all([
    translatedCues(cues, "en", "nl", cfg, transport(() => calls++), shared),
    translatedCues(retimed, "en", "nl", { ...cfg, apiKey: "different-owned-key" }, transport(() => calls++), { ...shared, release: "Another.Release.mkv" }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a[0]!.text, b[0]!.text);
  assert.equal(a[0]!.start, 1000);
  assert.equal(b[0]!.start, 10000);
  const stored = library.list()[0]!;
  assert.equal(stored.variants.length, 2);
  assert.notEqual(stored.variants[0], stored.variants[1]);
}));

test("private profiles never reuse each other's artifacts by default", async () => fixture(async (library) => {
  let calls = 0;
  const cfg = settings();
  for (const profile of ["first-owned-profile", "second-owned-profile"]) {
    await translatedCues(cues, "en", "nl", cfg, transport(() => calls++), { ...context, scope: `user-${hash(profile)}` });
  }
  assert.equal(calls, 2);
  assert.equal(library.list().length, 2);
}));

test("failed or interrupted work never creates a reusable completed artifact", async () => fixture(async (library) => {
  const cfg = settings();
  await assert.rejects(translatedCues(cues, "en", "nl", cfg, async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "partial" } }] }), context));
  assert.deepEqual(library.list(), []);
  const temporary = path.join(library.root, "server", ".tmp-interrupted");
  fs.mkdirSync(temporary, { recursive: true });
  fs.writeFileSync(path.join(temporary, "partial.json"), "unfinished");
  assert.deepEqual(new TranslationLibrary(library.root).list(), []);
}));

test("full storage blocks new AI work without evicting validated translations", async () => fixture(async (library) => {
  let calls = 0;
  const cfg = settings();
  await translatedCues(cues, "en", "nl", cfg, transport(() => calls++), context);
  process.env.TRANSLATION_LIBRARY_MAX_ITEMS = "1";
  await assert.rejects(translatedCues(cues, "en", "de", cfg, transport(() => calls++), context), (error: unknown) => (error as { status?: number }).status === 507);
  assert.equal(calls, 1);
  assert.equal(library.list().length, 1);
  assert.equal((await translatedCues(cues, "en", "nl", cfg, transport(() => calls++), context))[0]!.text, "Owned translation 1");
  assert.equal(calls, 1);
}));

test("byte reservations include simultaneous jobs and reject unusable volumes before AI", async () => fixture(async (library, dir) => {
  process.env.TRANSLATION_LIBRARY_MAX_ITEMS = "1";
  const release = library.reserve(cues);
  try { assert.throws(() => library.reserve(cues), /full/); } finally { release(); }
  process.env.TRANSLATION_LIBRARY_MAX_BYTES = "1";
  let calls = 0;
  await assert.rejects(translatedCues(cues, "en", "nl", settings(), transport(() => calls++), context), /full/);
  assert.equal(calls, 0);
  process.env.TRANSLATION_LIBRARY_DIR = path.join(dir, "not-a-directory");
  fs.writeFileSync(process.env.TRANSLATION_LIBRARY_DIR, "owned fixture");
  await assert.rejects(translatedCues(cues, "en", "nl", settings(), transport(() => calls++), context), /unavailable/);
  assert.equal(calls, 0);
}));

test("corrupt stored text/variant checksums fail closed without another AI charge", async () => fixture(async (library) => {
  const cfg = settings();
  await translatedCues(cues, "en", "nl", cfg, transport(() => undefined), context);
  const entry = library.list()[0]!;
  const srt = path.join(library.root, "server", entry.id, "variants", entry.variants[0]!, "subtitle.srt");
  fs.appendFileSync(srt, "tampered");
  assert.throws(() => library.variant("server", entry.id, entry.variants[0]!), /corrupt/);
  const file = path.join(library.root, "server", entry.id, "artifact.json");
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  artifact.texts[0] = "tampered";
  fs.writeFileSync(file, JSON.stringify(artifact));
  let calls = 0;
  await assert.rejects(translatedCues(cues, "en", "nl", cfg, transport(() => calls++), context), /corrupt/);
  assert.equal(calls, 0);
}));

test("backup, restore, exact-variant export and explicit deletion retain their documented semantics", async () => fixture(async (library, dir) => {
  const cfg = settings();
  await translatedCues(cues, "en", "nl", cfg, transport(() => undefined), context);
  const entry = library.list()[0]!;
  const bundle = path.join(dir, "export");
  library.export("server", entry.id, entry.variants[0]!, bundle);
  assert.ok(fs.readFileSync(path.join(bundle, "subtitle.srt"), "utf8").includes("Owned translation"));
  assert.ok(JSON.parse(fs.readFileSync(path.join(bundle, "provenance.json"), "utf8")).artifact);
  assert.throws(() => library.export("server", entry.id, entry.variants[0]!, bundle), /already exist/);
  const backup = path.join(dir, "backup");
  library.backup(backup);
  const restored = path.join(dir, "restored");
  execFileSync(process.execPath, ["--import", "tsx", "src/library/cli.ts", "restore", backup], { env: { ...process.env, TRANSLATION_LIBRARY_DIR: restored } });
  assert.deepEqual(new TranslationLibrary(restored).list(), library.list());
  library.delete("server", entry.id);
  assert.deepEqual(library.list(), []);
  let calls = 0;
  await translatedCues(cues, "en", "nl", cfg, transport(() => calls++), context);
  assert.equal(calls, 1, "deletion must not be bypassed by an old memory cache");
}));

test("filesystem references reject traversal and invalid timing variants", async () => fixture(async (library) => {
  assert.throws(() => library.load("../../", "a".repeat(64)), /Invalid library/);
  assert.throws(() => library.load("server", "../secret"), /Invalid library/);
  const cfg = settings();
  const artifact = library.save("server", artifactIdentity(cues, "en", "nl", cfg), ["One", "Two"]);
  assert.throws(() => library.saveVariant("server", artifact, cues.slice(0, 1), context), /Invalid timing/);
}));
