import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pairShowClear, readIndexedSubtitles } from "../src/embedded/mkvcues";

/**
 * A small Matroska file written by hand: the seek table, track list and index
 * are real EBML, the media is a block of padding. Writing it by hand is what
 * makes the cases a remux has and an ffmpeg-built fixture does not possible to
 * test: an index past the first read, and a PGS track with no durations.
 */

function idBytes(id: number): Buffer {
  const bytes: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from(bytes);
}

/** Every size is written as an 8-byte vint, so element lengths never depend on their content. */
function el(id: number, ...parts: Buffer[]): Buffer {
  const payload = Buffer.concat(parts);
  const size = Buffer.alloc(8);
  size[0] = 0x01;
  size.writeUIntBE(payload.length, 2, 6);
  return Buffer.concat([idBytes(id), size, payload]);
}

function uint(id: number, value: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(value));
  return el(id, b);
}

function text(id: number, value: string): Buffer {
  return el(id, Buffer.from(value, "utf8"));
}

const LINES = 60;

function buildMkv(): Buffer {
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000));
  const tracks = el(
    0x1654ae6b,
    el(0xae, uint(0xd7, 1), uint(0x83, 1), text(0x86, "V_MPEG4/ISO/AVC")),
    el(0xae, uint(0xd7, 2), uint(0x83, 17), text(0x86, "S_TEXT/UTF8")),
    el(0xae, uint(0xd7, 3), uint(0x83, 17), text(0x86, "S_HDMV/PGS")),
  );
  // Stands in for the media, and pushes the index past the first 256 KB read.
  const media = el(0xec, Buffer.alloc(300 * 1024));

  const points: Buffer[] = [];
  for (let i = 0; i < LINES; i++) {
    const t = 10_000 + i * 5_000;
    points.push(el(0xbb, uint(0xb3, t), el(0xb7, uint(0xf7, 1), uint(0xf1, 0))));
    // A text line with its duration in the index.
    points.push(el(0xbb, uint(0xb3, t + 100), el(0xb7, uint(0xf7, 2), uint(0xf1, 0), uint(0xb2, 1_500))));
    // A PGS line: one event to show it, one to clear it.
    points.push(el(0xbb, uint(0xb3, t + 200), el(0xb7, uint(0xf7, 3), uint(0xf1, 0))));
    points.push(el(0xbb, uint(0xb3, t + 2_700), el(0xb7, uint(0xf7, 3), uint(0xf1, 0))));
  }
  const cues = el(0x1c53bb6b, ...points);

  const seekHead = (positions: number[]): Buffer =>
    el(
      0x114d9b74,
      ...[0x1549a966, 0x1654ae6b, 0x1c53bb6b].map((target, i) =>
        el(0x4dbb, el(0x53ab, idBytes(target)), uint(0x53ac, positions[i]!)),
      ),
    );
  // Positions count from the start of the segment's data, where the seek table sits.
  const infoAt = seekHead([0, 0, 0]).length;
  const tracksAt = infoAt + info.length;
  const cuesAt = tracksAt + tracks.length + media.length;

  const segment = el(0x18538067, seekHead([infoAt, tracksAt, cuesAt]), info, tracks, media, cues);
  return Buffer.concat([el(0x1a45dfa3, text(0x4282, "matroska")), segment]);
}

const MKV = buildMkv();
let server: http.Server;
let base = "";
let fullReads = 0;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/plain.mkv") {
      // A host that ignores ranges and starts sending everything.
      fullReads++;
      res.writeHead(200, { "Content-Length": MKV.length, "Content-Type": "video/x-matroska" });
      res.end(MKV);
      return;
    }
    const body = req.url === "/film.mp4" ? Buffer.alloc(MKV.length) : MKV;
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = m ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, {
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${body.length}`,
      "Content-Type": "video/x-matroska",
    });
    res.end(body.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("the index gives every line of every subtitle track", async () => {
  const tracks = await readIndexedSubtitles(`${base}/film.mkv`);
  assert.ok(tracks, "no index was read");
  assert.equal(tracks.length, 2);

  const [textTrack, pgsTrack] = tracks;
  assert.equal(textTrack!.order, 0);
  assert.equal(textTrack!.codec, "S_TEXT/UTF8");
  assert.equal(textTrack!.cues.length, LINES);
  assert.deepEqual(textTrack!.cues[0], { start: 10_100, end: 11_600, text: "" });

  assert.equal(pgsTrack!.order, 1);
  assert.equal(pgsTrack!.codec, "S_HDMV/PGS");
  // Two events per line, paired back into one line each.
  assert.equal(pgsTrack!.cues.length, LINES);
  assert.deepEqual(pgsTrack!.cues[0], { start: 10_200, end: 12_700, text: "" });
});

test("a host that ignores the range is never read in full", async () => {
  await assert.rejects(readIndexedSubtitles(`${base}/plain.mkv`), /not 206/);
  assert.equal(fullReads, 1);
});

test("a file that is not Matroska has no index", async () => {
  assert.equal(await readIndexedSubtitles(`${base}/film.mp4`), null);
});

test("PGS show and clear events pair into lines", () => {
  assert.deepEqual(pairShowClear([1_000, 3_000, 3_100, 5_000]), [
    { start: 1_000, end: 3_000, text: "" },
    { start: 3_100, end: 5_000, text: "" },
  ]);
});

test("a long gap starts the pairing again instead of flipping every later line", () => {
  // The clear event after 20s is missing. Pairing 20s with 40s would make that
  // "line" twenty seconds long and turn every later line into a gap.
  assert.deepEqual(pairShowClear([1_000, 3_000, 20_000, 40_000, 42_000]), [
    { start: 1_000, end: 3_000, text: "" },
    { start: 20_000, end: 22_000, text: "" },
    { start: 40_000, end: 42_000, text: "" },
  ]);
});
