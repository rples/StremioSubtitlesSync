import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { toSrt } from "../src/subtitles/serialize";
import type { Cue } from "../src/subtitles/types";

const run = promisify(execFile);

/**
 * Option B, end to end, against real tools.
 *
 * A real MKV with a real embedded subtitle track is built with ffmpeg, served
 * over HTTP with range support, and advertised through a stub TorBox API. The
 * addon then has to find it, prove it by hash, probe it, sample it with
 * ffprobe, and align a deliberately mistimed subtitle to it.
 *
 * Skipped when ffmpeg is unavailable, since it builds the fixture.
 */

/** Checked synchronously: the skip flag is needed before any test is defined. */
function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const FILM_SECONDS = 300;
const OFFSET_MS = 6_000;

function stamp(ms: number): string {
  const s = Math.max(0, ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(s / 3600000))}:${pad(Math.floor(s / 60000) % 60)}:${pad(
    Math.floor(s / 1000) % 60,
  )},${pad(s % 1000, 3)}`;
}

/** Dialogue at a realistic pace, so the sampled windows actually catch some. */
function dialogue(): Cue[] {
  const cues: Cue[] = [];
  let t = 4_000;
  let i = 0;
  while (t < FILM_SECONDS * 1000 - 5_000) {
    const duration = 1200 + ((i * 431) % 1800);
    cues.push({ start: t, end: t + duration, text: `spoken line ${i}` });
    t += duration + 300 + ((i * 257) % 1700);
    i++;
  }
  return cues;
}

let dir = "";
let media: http.Server;
let stub: http.Server;
let mediaPort = 0;
let stubPort = 0;
let fileSize = 0;
/** How many more requests under /busy/ the media host refuses with 429. */
let busyRefusals = 0;
const CUES = dialogue();

describe("reading a timing reference out of the video", { skip: !hasFfmpeg() }, () => {
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "subsync-"));
    const srt = path.join(dir, "cues.srt");
    fs.writeFileSync(
      srt,
      CUES.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join("\n"),
      "utf8",
    );

    // Must clear the 50 MB floor the file matcher uses to rule out sample
    // files, so the bitrate here is deliberately generous for the frame size.
    const video = path.join(dir, "video.mkv");
    const mkv = path.join(dir, "film.mkv");
    await run(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-f", "lavfi", "-i",
       `testsrc2=s=640x360:d=${FILM_SECONDS}:r=15`,
       "-c:v", "libx264", "-preset", "ultrafast",
       // Forced constant bitrate: test patterns compress far too well otherwise
       // and the fixture lands under the matcher's size floor.
       "-b:v", "2M", "-minrate", "2M", "-maxrate", "2M", "-bufsize", "4M",
       video],
      { windowsHide: true, timeout: 180_000 },
    );
    await run(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", video, "-i", srt, "-c", "copy", "-c:s", "srt", mkv],
      { windowsHide: true, timeout: 120_000 },
    );
    fileSize = fs.statSync(mkv).size;

    // A media host that honours range requests, like a debrid CDN.
    media = http.createServer((req, res) => {
      // A CDN with too many connections open for this link: /refused/ always
      // says so, /busy/ only while refusals are left.
      const route = req.url ?? "";
      if (route.startsWith("/refused/") || (route.startsWith("/busy/") && busyRefusals > 0)) {
        if (route.startsWith("/busy/")) busyRefusals--;
        res.writeHead(429, "Too Many Requests");
        res.end();
        return;
      }

      const m =/bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : fileSize - 1;
      res.writeHead(m ? 206 : 200, {
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Type": "video/x-matroska",
      });
      fs.createReadStream(mkv, { start, end }).pipe(res);
    });
    await new Promise<void>((r) => media.listen(0, "127.0.0.1", r));
    mediaPort = (media.address() as AddressInfo).port;

    stub = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stub");
      res.setHeader("Content-Type", "application/json");

      if (url.pathname === "/torrents/mylist") {
        res.end(
          JSON.stringify({
            data: [
              {
                id: 77,
                name: "Some.Film.2024",
                files: [
                  { id: 0, short_name: "sample.mkv", size: 1024 },
                  { id: 1, short_name: "Some.Film.2024.1080p.mkv", size: fileSize },
                ],
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === "/torrents/requestdl") {
        res.end(JSON.stringify({ data: `http://127.0.0.1:${mediaPort}/film.mkv` }));
        return;
      }
      // usenet and webdl lists are empty for this account.
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    stubPort = (stub.address() as AddressInfo).port;

    process.env.TORBOX_API_BASE = `http://127.0.0.1:${stubPort}`;
    process.env.TORBOX_API_KEY = "test-key";
  });

  after(async () => {
    await new Promise<void>((r) => media.close(() => r()));
    await new Promise<void>((r) => stub.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.TORBOX_API_BASE;
    delete process.env.TORBOX_API_KEY;
  });

  test("finds the file, proves it by hash, and reads its subtitle timings", async () => {
    const { hashRemoteFile } = await import("../src/embedded/oshash.js");
    const { resolveConfig } = await import("../src/config.js");
    const { probeEmbedded, embeddedReference } = await import("../src/embedded/reference.js");

    const url = `http://127.0.0.1:${mediaPort}/film.mkv`;
    const realHash = await hashRemoteFile(url, fileSize);
    assert.ok(realHash, "could not hash the served file");

    const hint = { videoHash: realHash, videoSize: fileSize, filename: "Some.Film.2024.1080p.mkv" };
    const config = resolveConfig(undefined);

    const target = await probeEmbedded(hint, config);
    assert.ok(target, "the embedded track was not found");
    // The sample file must not have been picked.
    assert.equal(target.file.size, fileSize);
    assert.equal(target.track.codec, "subrip");

    const reference = await embeddedReference(hint, config);
    assert.ok(reference, "no reference was built");
    // ffmpeg lists subtitle packets in the file's seek index, so the reference
    // comes from there: every line in the film, not just the sampled windows.
    assert.equal(reference.length, CUES.length);
    assert.deepEqual(
      reference.map((c) => c.start),
      CUES.map((c) => c.start),
    );
  });

  test("packets found past the end of a window are not kept", async () => {
    const { readSubtitleTimings } = await import("../src/embedded/ffprobe.js");

    // A film whose only subtitle sits at 200s.
    const sparseSrt = path.join(dir, "sparse.srt");
    fs.writeFileSync(sparseSrt, "1\n00:03:20,000 --> 00:03:23,000\nonly cue\n\n", "utf8");
    const sparse = path.join(dir, "sparse.mkv");
    await run(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", path.join(dir, "video.mkv"), "-i", sparseSrt,
       "-c", "copy", "-c:s", "srt", sparse],
      { windowsHide: true, timeout: 120_000 },
    );

    // ffprobe does not stop at the end of a window when the selected stream has
    // no packet in it; it reads on until it finds one. Asking for 20s to 40s
    // here makes it return the 200s cue, so the filtering has to drop it.
    const cues = await readSubtitleTimings(sparse, 0, [
      { startSeconds: 20, durationSeconds: 20 },
    ]);
    assert.deepEqual(cues, [], "a cue from far outside the window was kept");

    // The same cue is kept when the window actually covers it.
    const inWindow = await readSubtitleTimings(sparse, 0, [
      { startSeconds: 195, durationSeconds: 20 },
    ]);
    assert.equal(inWindow.length, 1);
    assert.equal(inWindow[0]!.start, 200_000);
  });

  test("a window refused with 429 is retried and still read", async () => {
    const { readSubtitleTimings } = await import("../src/embedded/ffprobe.js");

    busyRefusals = 2;
    const cues = await readSubtitleTimings(
      `http://127.0.0.1:${mediaPort}/busy/film.mkv`,
      0,
      [{ startSeconds: 100, durationSeconds: 20 }],
      { retryDelaysMs: [10, 10, 10] },
    );

    assert.equal(busyRefusals, 0, "the refusals were not all used up");
    assert.ok(cues.length > 0, "nothing was read after the retries");
  });

  test("a read that stays refused fails instead of looking empty", async () => {
    const { readSubtitleTimings, RateLimitedError } = await import("../src/embedded/ffprobe.js");

    await assert.rejects(
      readSubtitleTimings(
        `http://127.0.0.1:${mediaPort}/refused/film.mkv`,
        0,
        [{ startSeconds: 100, durationSeconds: 20 }],
        { retryDelaysMs: [10] },
      ),
      RateLimitedError,
    );
  });

  test("a wrong hash is rejected instead of trusted", async () => {
    const { resolveConfig } = await import("../src/config.js");
    const { probeEmbedded } = await import("../src/embedded/reference.js");

    const target = await probeEmbedded(
      { videoHash: "0000000000000000", videoSize: fileSize, filename: "Some.Film.2024.1080p.mkv" },
      resolveConfig(undefined),
    );
    assert.equal(target, null);
  });

  test("a mistimed subtitle is aligned back onto the video", async () => {
    const { hashRemoteFile } = await import("../src/embedded/oshash.js");
    const { resolveConfig } = await import("../src/config.js");
    const { embeddedReference } = await import("../src/embedded/reference.js");
    const { align, applyAlignment } = await import("../src/subtitles/align.js");
    const { parseSubtitle } = await import("../src/subtitles/parse.js");

    const url = `http://127.0.0.1:${mediaPort}/film.mkv`;
    const realHash = await hashRemoteFile(url, fileSize);
    const reference = await embeddedReference(
      { videoHash: realHash ?? undefined, videoSize: fileSize, filename: "Some.Film.2024.1080p.mkv" },
      resolveConfig(undefined),
    );
    assert.ok(reference);

    // The subtitle a user downloaded: same film, running six seconds late.
    const late = parseSubtitle(
      toSrt(CUES.map((c) => ({ start: c.start + OFFSET_MS, end: c.end + OFFSET_MS, text: c.text }))),
    );

    const result = align(reference, late);
    assert.equal(result.applied, true, `peak was ${result.peakRatio}`);
    assert.ok(Math.abs(result.offsetMs + OFFSET_MS) <= 100, `offset was ${result.offsetMs}`);

    const fixed = applyAlignment(late, result);
    assert.ok(Math.abs(fixed[0]!.start - CUES[0]!.start) <= 100);
    assert.equal(fixed[0]!.text, CUES[0]!.text);
  });
});
