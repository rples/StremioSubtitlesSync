import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranslationLibrary, artifactIdentity, type LibraryContext } from "../src/library/store";
import { PublicationQueue, publicationMetadata, uploadCredentials, type PublishMetadata } from "../src/library/publishing";
import { translationSettings } from "../src/translation/config";

const base: PublishMetadata = { type: "movie", tmdbId: 123, imdbId: "tt1234567", name: "Owned fixture", releases: ["Owned.Release"], quality: "web", framerate: 0,
  season: 0, episode: 0, hearingImpaired: false, credits: "Owned source and translation fixture", reviewNote: "Reviewed the complete owned fixture against this release",
  rightsConfirmed: true, qualityReviewed: true, accountOwnerConsent: true };
async function fixture(run: (queue: PublicationQueue, library: TranslationLibrary, artifactId: string, variantId: string) => Promise<void>, episode = false): Promise<void> {
  const names = ["SUBDL_PUBLISHING_ENABLED", "SUBDL_UPLOAD_TOKEN", "SUBDL_UPLOAD_TOKEN_FILE", "SUBDL_UPLOAD_HEADER_MODE", "TRANSLATION_LIBRARY_MAX_BYTES", "TRANSLATION_LIBRARY_MAX_ITEMS"];
  const saved = names.map((name) => process.env[name]);
  process.env.SUBDL_PUBLISHING_ENABLED = "true";
  delete process.env.TRANSLATION_LIBRARY_MAX_BYTES;
  delete process.env.TRANSLATION_LIBRARY_MAX_ITEMS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsync-publishing-"));
  try {
    const library = new TranslationLibrary(dir);
    const cfg = translationSettings({ aiEnabled: "true", aiBaseUrl: "https://owned.invalid/v1", aiModel: "owned-model" }, false)!;
    const cues = [{ start: 1000, end: 2500, text: "Owned source" }];
    const artifact = library.save("server", artifactIdentity(cues, "en", "nl", cfg), ["Owned translation"]);
    const context: LibraryContext = { scope: "server", timing: "exact", source: { provider: "subdl", fileId: "owned~source", language: "en" },
      videoId: episode ? "tt1234567:2:3" : "tt1234567", release: "Owned.Release.mkv" };
    const variant = library.saveVariant("server", artifact, cues, context);
    await run(new PublicationQueue(library), library, artifact.id, variant.id);
  } finally {
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function uploader(requests: { route: string; token: string; form?: FormData }[], final: () => Response | Promise<Response> = () => Response.json({ status: true, message: "owned review response" })): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api3.subdl.com");
    assert.equal(init?.redirect, "error");
    const route = url.pathname.split("/").at(-1)!;
    requests.push({ route, token: new Headers(init?.headers).get("token")!, form: init?.body instanceof FormData ? init.body : undefined });
    if (route === "getNId") return Response.json({ ok: true, n_id: "owned-session" });
    if (route === "uploadSingleSubtitle") return Response.json({ ok: true, n_id: "owned-session", file: { file_n_id: "owned-file" } });
    assert.equal(route, "uploadSubtitle");
    return final();
  };
}

test("publication requires explicit rights, owner consent, QC and valid complete metadata", () => {
  for (const bad of [{ ...base, rightsConfirmed: false }, { ...base, accountOwnerConsent: false }, { ...base, qualityReviewed: false },
    { ...base, reviewNote: "" }, { ...base, credits: "" }, { ...base, tmdbId: 0 }, { ...base, releases: [] }, { ...base, type: "tv", episode: 0 },
    { ...base, production_type: 0 }, { ...base, framerate: 99 }]) assert.throws(() => publicationMetadata(bad));
  assert.deepEqual(publicationMetadata(base), base);
});

test("upload credentials are separate, disabled by default and require an explicit header mode", async () => fixture(async () => {
  process.env.SUBDL_PUBLISHING_ENABLED = "false";
  assert.throws(uploadCredentials, /disabled/);
  process.env.SUBDL_PUBLISHING_ENABLED = "true";
  delete process.env.SUBDL_UPLOAD_TOKEN;
  delete process.env.SUBDL_UPLOAD_TOKEN_FILE;
  assert.throws(uploadCredentials, /separate upload token/);
  process.env.SUBDL_UPLOAD_TOKEN = "owned-upload-token";
  delete process.env.SUBDL_UPLOAD_HEADER_MODE;
  assert.throws(uploadCredentials, /explicitly verified/);
  process.env.SUBDL_UPLOAD_HEADER_MODE = "raw";
  assert.deepEqual(uploadCredentials(), { token: "owned-upload-token", mode: "raw" });
}));

test("outbox deduplicates timing variants without silently changing reviewed metadata", async () => fixture(async (queue, _library, id, variant) => {
  const a = queue.create("server", id, variant, base);
  const b = queue.create("server", id, variant, { ...base, reviewNote: "A different note" });
  assert.equal(a.id, b.id);
  assert.equal(b.metadata.reviewNote, base.reviewNote);
  assert.equal(queue.list().length, 1);
  assert.equal(queue.approve(a.id).state, "approved");
  assert.throws(() => queue.approve(a.id), /reviewed draft/);
}));

test("changing approved metadata invalidates the review and locked items cannot be cancelled", async () => fixture(async (queue, library, id, variant) => {
  const created = queue.create("server", id, variant, base);
  const approved = queue.approve(created.id);
  const lock = path.join(library.root, "outbox", created.id + ".json.lock");
  fs.writeFileSync(lock, "active fixture");
  assert.throws(() => queue.cancel(created.id), /locked/);
  fs.rmSync(lock);
  approved.metadata.reviewNote = "Changed after approval";
  library.writePublication(created.id, approved);
  await assert.rejects(queue.submit(created.id, { token: "owned-token", mode: "raw" }, uploader([])), /invalid/);
}));

test("publication refuses mismatched title, episode and release metadata", async () => fixture(async (queue, _library, id, variant) => {
  assert.throws(() => queue.create("server", id, variant, { ...base, imdbId: "tt9999999" }), /source identity/);
  assert.throws(() => queue.create("server", id, variant, { ...base, releases: ["Unrelated.Release"] }), /playback release/);
  assert.throws(() => queue.create("server", id, "a".repeat(64), base), /completed library/);
}));

for (const mode of ["raw", "bearer-final"] as const) {
  test(`three-step ${mode} upload preserves AI attribution and stops at submitted`, async () => fixture(async (queue, library, id, variant) => {
    const item = queue.create("server", id, variant, base);
    const requests: { route: string; token: string; form?: FormData }[] = [];
    await assert.rejects(queue.submit(item.id, { token: "owned-token", mode }, uploader(requests)), /approved/);
    assert.equal(requests.length, 0);
    queue.approve(item.id);
    const result = await queue.submit(item.id, { token: "owned-token", mode }, uploader(requests));
    assert.equal(result.state, "submitted");
    assert.equal(requests.length, 3);
    assert.equal(requests[0]!.token, "owned-token");
    assert.equal(requests[1]!.token, "owned-token");
    assert.equal(requests[2]!.token, mode === "raw" ? "owned-token" : "Bearer owned-token");
    assert.equal(requests[2]!.form!.get("production_type"), "3");
    assert.equal(requests[2]!.form!.get("lang"), "NL");
    assert.equal(requests[2]!.form!.get("is_full_season"), "false");
    assert.match(String(requests[2]!.form!.get("comment")), /AI-translated.*owned-model.*subdl:owned~source/);
    const file = requests[1]!.form!.get("subtitle") as Blob;
    assert.ok((await file.text()).includes("Owned translation"));
    assert.ok(!JSON.stringify(queue.load(item.id)).includes("owned-token"));
    assert.ok(library.load("server", id));
    await assert.rejects(queue.submit(item.id, { token: "owned-token", mode }, uploader(requests)), /approved/);
    assert.equal(requests.length, 3);
  }));
}

test("overlapping submit attempts cannot send the same queue item twice", async () => fixture(async (queue, library, id, variant) => {
  const item = queue.create("server", id, variant, base);
  queue.approve(item.id);
  const requests: { route: string; token: string; form?: FormData }[] = [];
  const first = queue.submit(item.id, { token: "owned-token", mode: "raw" }, uploader(requests));
  await assert.rejects(new PublicationQueue(library).submit(item.id, { token: "owned-token", mode: "raw" }, uploader(requests)), /approved|worker/);
  assert.equal((await first).state, "submitted");
  assert.equal(requests.length, 3);
  assert.equal(queue.load(item.id).attempts, 1);
}));

test("series uploads carry the exact reviewed episode, not an inferred season pack", async () => fixture(async (queue, _library, id, variant) => {
  const metadata = { ...base, type: "tv", season: 2, episode: 3 };
  assert.throws(() => queue.create("server", id, variant, { ...metadata, episode: 4 }), /source identity/);
  const item = queue.create("server", id, variant, metadata);
  queue.approve(item.id);
  const requests: { route: string; token: string; form?: FormData }[] = [];
  await queue.submit(item.id, { token: "owned-token", mode: "raw" }, uploader(requests));
  assert.equal(requests[2]!.form!.get("type"), "tv");
  assert.equal(requests[2]!.form!.get("season"), "2");
  assert.equal(requests[2]!.form!.get("ef"), "3");
  assert.equal(requests[2]!.form!.get("ee"), "3");
}, true));

test("timeout after submission records uncertainty and never automatically repeats a possibly accepted upload", async () => fixture(async (queue, library, id, variant) => {
  const item = queue.create("server", id, variant, base);
  queue.approve(item.id);
  const requests: { route: string; token: string; form?: FormData }[] = [];
  const result = await queue.submit(item.id, { token: "PRIVATE-TOKEN", mode: "raw" }, uploader(requests, async () => { throw new Error("PRIVATE-TOKEN and signed URL"); }));
  assert.equal(result.state, "uncertain");
  assert.ok(!JSON.stringify(result).includes("PRIVATE-TOKEN"));
  assert.ok(result.fileId);
  assert.equal(new PublicationQueue(library).load(item.id).state, "uncertain");
  await assert.rejects(queue.submit(item.id, { token: "PRIVATE-TOKEN", mode: "raw" }, uploader(requests)), /approved/);
  assert.equal(requests.length, 3);
  assert.throws(() => queue.reconcile(item.id, "submitted", false), /Stop all/);
  assert.equal(queue.reconcile(item.id, "submitted", true).state, "submitted");
  assert.ok(library.variant("server", id, variant));
}));

test("explicit rejection retains local data and requires operator reconciliation before retry", async () => fixture(async (queue, library, id, variant) => {
  const item = queue.create("server", id, variant, base);
  queue.approve(item.id);
  const result = await queue.submit(item.id, { token: "owned-token", mode: "raw" }, uploader([], () => Response.json({ status: false, message: "PRIVATE BODY" })));
  assert.equal(result.state, "rejected");
  assert.ok(!JSON.stringify(result).includes("PRIVATE BODY"));
  assert.ok(library.load("server", id));
  assert.equal(queue.reconcile(item.id, "not-submitted", true).state, "draft");
  assert.equal(queue.approve(item.id).state, "approved");
}));

test("interrupted workers remain blocked until explicit reconciliation", async () => fixture(async (queue, library, id, variant) => {
  const created = queue.create("server", id, variant, base);
  const item = queue.approve(created.id);
  item.state = "uploading";
  library.writePublication(item.id, item);
  const lock = path.join(library.root, "outbox", item.id + ".json.lock");
  fs.writeFileSync(lock, "interrupted fixture");
  await assert.rejects(new PublicationQueue(library).submit(item.id, { token: "owned-token", mode: "raw" }, uploader([])), /approved/);
  queue.reconcile(item.id, "not-submitted", true);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(queue.load(item.id).state, "draft");
}));

test("a successful HTTP submission never implies publication; manual confirmation is explicitly labelled", async () => fixture(async (queue, _library, id, variant) => {
  const item = queue.create("server", id, variant, base);
  assert.throws(() => queue.confirmPublic(item.id, "https://subdl.com/subtitle/owned"), /Only submitted/);
  queue.approve(item.id);
  await queue.submit(item.id, { token: "owned-token", mode: "raw" }, uploader([]));
  assert.throws(() => queue.confirmPublic(item.id, "https://subdl.com.evil.invalid/subtitle/owned"), /Invalid/);
  const result = queue.confirmPublic(item.id, "https://subdl.com/subtitle/owned-fixture");
  assert.equal(result.state, "published-manual");
  assert.equal(result.publicUrl, "https://subdl.com/subtitle/owned-fixture");
}));

test("manual moderation rejection retains the library and never triggers a replacement upload", async () => fixture(async (queue, library, id, variant) => {
  const item = queue.create("server", id, variant, base);
  queue.approve(item.id);
  const requests: { route: string; token: string; form?: FormData }[] = [];
  await queue.submit(item.id, { token: "owned-token", mode: "raw" }, uploader(requests));
  assert.equal(queue.recordRejection(item.id, "Operator checked the moderation decision").state, "moderation-rejected");
  assert.ok(library.load("server", id));
  await assert.rejects(queue.submit(item.id, { token: "owned-token", mode: "raw" }, uploader(requests)), /approved/);
  assert.equal(requests.length, 3);
}));

test("malformed remote IDs and redirects are uncertain and never followed or echoed", async () => fixture(async (queue, _library, id, variant) => {
  const item = queue.create("server", id, variant, base);
  queue.approve(item.id);
  let calls = 0;
  const result = await queue.submit(item.id, { token: "owned-token", mode: "raw" }, async (_input, init) => {
    calls++;
    assert.equal(init?.redirect, "error");
    return Response.json({ ok: true, n_id: "../PRIVATE" });
  });
  assert.equal(result.state, "uncertain");
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
}));
