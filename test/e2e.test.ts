import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { getRouter } from "stremio-addon-sdk";
import { parseSubtitle } from "../src/subtitles/parse";
import { toSrt } from "../src/subtitles/serialize";
import type { Cue } from "../src/subtitles/types";

/**
 * Drives the real addon end to end against a stub OpenSubtitles.
 *
 * The point is to prove the whole chain: Stremio asks for subtitles, the addon
 * picks the hash-matched file as the anchor, hands back a URL, and fetching
 * that URL returns a subtitle whose timings now line up with the anchor.
 */

const ANCHOR_FILE_ID = 100;
const SHIFTED_FILE_ID = 200;
const EXACT_FILE_ID = 300;
const SHIFT_MS = 7_500;

function reference(): Cue[] {
  const cues: Cue[] = [];
  let t = 30_000;
  for (let i = 0; i < 400; i++) {
    const duration = 1200 + ((i * 617) % 2600);
    cues.push({ start: t, end: t + duration, text: `English line ${i}` });
    t += duration + 400 + ((i * 331) % 4000);
  }
  return cues;
}

const REFERENCE = reference();
const SHIFTED = REFERENCE.map((c, i) => ({
  start: c.start + SHIFT_MS,
  end: c.end + SHIFT_MS,
  text: `Polska linia ${i}`,
}));

const FILES: Record<number, Cue[]> = {
  [ANCHOR_FILE_ID]: REFERENCE,
  [SHIFTED_FILE_ID]: SHIFTED,
  [EXACT_FILE_ID]: REFERENCE.map((c, i) => ({ ...c, text: `Dokladna linia ${i}` })),
};

function searchItem(fileId: number, language: string, hashMatch: boolean): unknown {
  return {
    id: String(fileId),
    attributes: {
      language,
      release: "Test.Movie.2024.1080p.BluRay.x264-GROUP",
      download_count: 1000 + fileId,
      ratings: 8,
      moviehash_match: hashMatch,
      files: [{ file_id: fileId, file_name: `file-${fileId}.srt` }],
    },
  };
}

let stub: http.Server;
let stubPort = 0;
let addon: http.Server;
let addonPort = 0;

before(async () => {
  stub = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");

    if (url.pathname === "/api/v1/subtitles") {
      // OpenSubtitles can only flag a hash match when a hash was sent, so the
      // stub mirrors that. It is what makes the "no anchor" case reachable.
      const hashed = url.searchParams.has("moviehash");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            searchItem(ANCHOR_FILE_ID, "en", hashed),
            searchItem(SHIFTED_FILE_ID, "pl", false),
            searchItem(EXACT_FILE_ID, "pl", hashed),
          ],
        }),
      );
      return;
    }

    if (url.pathname === "/api/v1/download" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const fileId = Number(JSON.parse(body).file_id);
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            link: `http://127.0.0.1:${stubPort}/files/${fileId}.srt`,
            remaining: 42,
          }),
        );
      });
      return;
    }

    const file = /^\/files\/(\d+)\.srt$/.exec(url.pathname);
    if (file) {
      const cues = FILES[Number(file[1])];
      if (cues) {
        res.setHeader("Content-Type", "text/plain");
        res.end(toSrt(cues));
        return;
      }
    }

    res.statusCode = 404;
    res.end("nope");
  });

  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubPort = (stub.address() as AddressInfo).port;

  // Must be in place before the addon modules are loaded.
  process.env.OS_API_BASE = `http://127.0.0.1:${stubPort}/api/v1`;
  process.env.OS_API_KEY = "test-key";
  process.env.LANGUAGES = "pl";
  process.env.ANCHOR_LANGUAGES = "en";
  delete process.env.BASE_URL;

  // Only the addon's own modules need the late import: they read the
  // environment at load time.
  const { addonInterface } = await import("../src/addon.js");
  const { runWithRequest } = await import("../src/context.js");
  const { subtitleRoutes } = await import("../src/routes/subtitles.js");

  const app = express();
  app.set("trust proxy", true);
  app.use((req, _res, next) => runWithRequest(req, next));
  app.use(subtitleRoutes());
  app.use(getRouter(addonInterface));

  addon = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => addon.on("listening", resolve));
  addonPort = (addon.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => addon.close(() => resolve()));
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

interface SubtitleEntry {
  id: string;
  url: string;
  lang: string;
}

async function requestSubtitles(): Promise<SubtitleEntry[]> {
  const extra = "videoHash=8e245d9679d31e12&videoSize=1632335363&filename=Test.Movie.2024.1080p.BluRay.x264-GROUP.mkv";
  const response = await fetch(
    `http://127.0.0.1:${addonPort}/subtitles/movie/tt1234567/${extra}.json`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { subtitles: SubtitleEntry[] };
  return body.subtitles;
}

test("offers the exact match first and the shifted one as auto-synced", async () => {
  const subtitles = await requestSubtitles();

  assert.equal(subtitles.length, 2);
  // Plain codes, so Stremio lists them under its own "Polski" entry.
  assert.equal(subtitles[0]!.lang, "pol");
  assert.equal(subtitles[0]!.id, `exact-${EXACT_FILE_ID}`);
  assert.ok(subtitles[0]!.url.includes(`/s/${EXACT_FILE_ID}.pl/`), subtitles[0]!.url);

  assert.equal(subtitles[1]!.lang, "pol");
  assert.equal(subtitles[1]!.id, `synced-${SHIFTED_FILE_ID}`);
  assert.ok(
    subtitles[1]!.url.includes(`/x/${ANCHOR_FILE_ID}.en/${SHIFTED_FILE_ID}.pl/`),
    subtitles[1]!.url,
  );
  // The URL must be absolute and point back at this addon.
  assert.ok(subtitles[1]!.url.startsWith(`http://127.0.0.1:${addonPort}/`));
});

test("verbose labels name the timing method when asked for", async () => {
  process.env.LABELS = "verbose";
  try {
    const subtitles = await requestSubtitles();
    assert.deepEqual(
      subtitles.map((s) => s.lang),
      ["Polish - exact match", "Polish - auto-synced"],
    );
  } finally {
    delete process.env.LABELS;
  }
});

test("fetching the synced URL returns subtitles aligned to the anchor", async () => {
  const subtitles = await requestSubtitles();
  const response = await fetch(subtitles[1]!.url);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /x-subrip/);

  const header = response.headers.get("x-subtitle-sync") ?? "";
  assert.match(header, /offset=-7500ms/, `sync header was "${header}"`);

  const cues = parseSubtitle(await response.text());
  assert.equal(cues.length, SHIFTED.length);
  // Text stays Polish; only the timing moved.
  assert.equal(cues[0]!.text, "Polska linia 0");
  for (let i = 0; i < cues.length; i++) {
    assert.ok(
      Math.abs(cues[i]!.start - REFERENCE[i]!.start) <= 40,
      `cue ${i} landed at ${cues[i]!.start}, reference is ${REFERENCE[i]!.start}`,
    );
  }
});

test("fetching an exact match returns it untouched", async () => {
  const subtitles = await requestSubtitles();
  const response = await fetch(subtitles[0]!.url);

  assert.equal(response.status, 200);
  const cues = parseSubtitle(await response.text());
  assert.equal(cues[0]!.start, REFERENCE[0]!.start);
  assert.equal(cues[0]!.text, "Dokladna linia 0");
});

/** No hash and an unrelated filename leaves nothing to anchor against. */
async function requestWithoutAnchor(): Promise<SubtitleEntry[]> {
  const response = await fetch(
    `http://127.0.0.1:${addonPort}/subtitles/movie/tt7654321/filename=Something.Else.1999.DVDRip.XviD-OTHER.mkv.json`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { subtitles: SubtitleEntry[] };
  return body.subtitles;
}

test("subtitles that cannot be synced are left out by default", async () => {
  assert.deepEqual(await requestWithoutAnchor(), []);
});

test("an empty answer is only cached briefly", async () => {
  const response = await fetch(
    `http://127.0.0.1:${addonPort}/subtitles/movie/tt7654321/filename=Something.Else.1999.DVDRip.XviD-OTHER.mkv.json`,
  );
  const body = (await response.json()) as { subtitles: SubtitleEntry[] };

  assert.deepEqual(body.subtitles, []);
  assert.match(response.headers.get("cache-control") ?? "", /max-age=300\b/);
});

test("unsynced subtitles come back when they are asked for", async () => {
  process.env.INCLUDE_UNSYNCED = "true";
  try {
    const subtitles = await requestWithoutAnchor();
    assert.ok(subtitles.length > 0);
    assert.ok(
      subtitles.every((s) => s.id.startsWith("unsynced-")),
      JSON.stringify(subtitles.map((s) => s.id)),
    );
  } finally {
    delete process.env.INCLUDE_UNSYNCED;
  }
});

test("an unknown anchor still delivers the subtitle, just unaligned", async () => {
  const response = await fetch(
    `http://127.0.0.1:${addonPort}/_/x/999.en/${SHIFTED_FILE_ID}.pl/test.srt`,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-subtitle-sync"), "anchor-unavailable");
  // Served only because the anchor failed, so it must not be cached as the synced file.
  assert.equal(response.headers.get("cache-control"), "no-store");
  const cues = parseSubtitle(await response.text());
  assert.equal(cues[0]!.start, SHIFTED[0]!.start);
});

// The transport intercepts only SubDL; Stremio and OpenSubtitles still use the
// real HTTP servers above. These fixtures are generated locally, not downloaded.
async function withSubdl(
  run: (downloads: () => number) => Promise<void>,
  failSearch = false,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.SUBDL_API_KEY;
  process.env.SUBDL_API_KEY = `fixture-${Math.random()}`;
  let downloads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.subdl.com") {
      assert.equal(init?.redirect, "error");
      if (failSearch) return new Response("private provider error", { status: 503 });
      return Response.json({
        status: true,
        results: [{ imdb_id: "tt1234567", type: "movie" }],
        subtitles: [{ language: "Polish", unpack_files: [{
          url: "https://dl.subdl.com/subtitle/owned/shifted?api_key=never-retain-this",
          format: "srt", name: "owned.srt",
        }] }],
      });
    }
    if (url.hostname === "dl.subdl.com") {
      downloads++;
      assert.equal(url.search, "");
      assert.equal(new Headers(init?.headers).get("X-API-Key"), process.env.SUBDL_API_KEY);
      return new Response(toSrt(SHIFTED));
    }
    return originalFetch(input, init);
  };
  try {
    await run(() => downloads);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.SUBDL_API_KEY;
    else process.env.SUBDL_API_KEY = previousKey;
  }
}

test("SubDL flows through Stremio listing and HTTP alignment without exposing its key", async () => {
  await withSubdl(async (downloads) => {
    const subtitles = await requestSubtitles();
    const entry = subtitles.find((subtitle) => subtitle.id === "synced-subdl-owned~shifted");
    assert.ok(entry);
    assert.equal(downloads(), 0, "listing must not spend download quota");
    assert.ok(entry.url.includes("/x/100.en/subdl~owned~shifted.pl/"));
    assert.ok(!entry.url.includes(process.env.SUBDL_API_KEY!));
    assert.ok(!entry.url.includes("never-retain-this"));
    const response = await fetch(entry.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-subtitle-sync") ?? "", /offset=-7500ms/);
    const cues = parseSubtitle(await response.text());
    assert.equal(cues.length, SHIFTED.length);
    assert.equal(cues[0]!.text, SHIFTED[0]!.text);
    for (let i = 0; i < cues.length; i++) {
      assert.ok(Math.abs(cues[i]!.start - REFERENCE[i]!.start) <= 40);
    }
    assert.equal(downloads(), 1);
    assert.equal((await fetch(entry.url)).status, 200);
    assert.equal(downloads(), 1);
  });
});

test("SubDL failure preserves existing OpenSubtitles results", async () => {
  await withSubdl(async () => {
    const subtitles = await requestSubtitles();
    assert.equal(subtitles.length, 2);
    assert.equal(subtitles[0]!.id, `exact-${EXACT_FILE_ID}`);
  }, true);
});

test("SubDL-only needs a timing reference by default; unsynced opt-in serves the selected file", async () => {
  const previousOsKey = process.env.OS_API_KEY;
  const previousUnsynced = process.env.INCLUDE_UNSYNCED;
  delete process.env.OS_API_KEY;
  try {
    await withSubdl(async (downloads) => {
      assert.deepEqual(await requestSubtitles(), []);
      process.env.INCLUDE_UNSYNCED = "true";
      const subtitles = await requestSubtitles();
      assert.equal(subtitles.length, 1);
      assert.equal(subtitles[0]!.id, "unsynced-subdl-owned~shifted");
      const response = await fetch(subtitles[0]!.url);
      assert.equal(response.status, 200);
      assert.equal(parseSubtitle(await response.text())[0]!.start, SHIFTED[0]!.start);
      assert.equal(downloads(), 1);
    });
  } finally {
    if (previousOsKey !== undefined) process.env.OS_API_KEY = previousOsKey;
    if (previousUnsynced === undefined) delete process.env.INCLUDE_UNSYNCED;
    else process.env.INCLUDE_UNSYNCED = previousUnsynced;
  }
});

test("OpenSubtitles failure preserves SubDL candidates", async () => {
  const originalFetch = globalThis.fetch;
  const previousUnsynced = process.env.INCLUDE_UNSYNCED;
  process.env.INCLUDE_UNSYNCED = "true";
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/api/v1/subtitles") {
      return new Response("unavailable", { status: 503 });
    }
    return originalFetch(input, init);
  };
  try {
    await withSubdl(async () => {
      // A new hash avoids the successful OpenSubtitles search cached above.
      const response = await fetch(`http://127.0.0.1:${addonPort}/subtitles/movie/tt1234567/videoHash=1111111111111111.json`);
      const body = await response.json() as { subtitles: SubtitleEntry[] };
      assert.equal(body.subtitles.length, 1);
      assert.equal(body.subtitles[0]!.id, "unsynced-subdl-owned~shifted");
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUnsynced === undefined) delete process.env.INCLUDE_UNSYNCED;
    else process.env.INCLUDE_UNSYNCED = previousUnsynced;
  }
});

test("SubDL download quota errors reach the player with Retry-After and a safe message", async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.SUBDL_API_KEY;
  process.env.SUBDL_API_KEY = "quota-route-fixture";
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).hostname === "dl.subdl.com") {
      return new Response("private key-bearing response", { status: 429, headers: { "Retry-After": "120" } });
    }
    return originalFetch(input, init);
  };
  try {
    const response = await fetch(`http://127.0.0.1:${addonPort}/_/s/subdl~quota~file.pl/test.srt`);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "120");
    assert.equal(await response.text(), "SubDL returned HTTP 429");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.SUBDL_API_KEY;
    else process.env.SUBDL_API_KEY = previousKey;
  }
});
