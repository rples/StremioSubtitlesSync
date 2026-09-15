import type { Cue } from "../subtitles/types";
import { RateLimitedError } from "./ffprobe";

/**
 * Reads subtitle timings out of a Matroska file's seek index.
 *
 * The Cues element is the index a player uses to seek. MKVToolNix, which makes
 * most remuxes, lists every subtitle packet in it, so a few hundred KB near the
 * end of the file hold the start of every subtitle line in the film. That is a
 * complete reference for a tiny share of what reading sample windows costs, and
 * unlike the windows it does not thin out on a film with little dialogue.
 *
 * Nothing here decodes media. It walks the EBML structure with range requests:
 * the head of the file for the seek table and track list, then the index.
 */

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Cluster: 0x1f43b675,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueDuration: 0xb2,
};

/** Enough for the seek table and track list of any ordinary file. */
const HEAD_BYTES = 256 * 1024;
/** A real index is well under a megabyte; anything past this is not worth fetching. */
const MAX_ELEMENT_BYTES = 32 * 1024 * 1024;
const TRACK_TYPE_SUBTITLE = 17;
/** Longer than any one line stays up. A gap this long means a clear event went missing. */
const MAX_LINE_MS = 10_000;
/** For an entry with a start but no end, a typical line length. */
const DEFAULT_LINE_MS = 2_000;

export interface IndexedTrack {
  /** Index among subtitle tracks only, the same numbering as ffprobe's s:N. */
  order: number;
  codec: string;
  cues: Cue[];
}

interface Entry {
  start: number;
  duration: number | undefined;
}

/**
 * Timings of every subtitle track, from the index alone.
 *
 * Returns null when the file is not Matroska or has no index to read. Throws
 * RateLimitedError when the host refuses the reads, since that says nothing
 * about the file.
 */
export async function readIndexedSubtitles(
  url: string,
  timeoutMs = 20_000,
): Promise<IndexedTrack[] | null> {
  const head = await readRange(url, 0, HEAD_BYTES - 1, timeoutMs);
  const top = children(head, 0, head.length);
  if (top[0]?.id !== ID.EBML) return null;
  const segment = top.find((el) => el.id === ID.Segment);
  if (!segment) return null;
  // Seek positions count from the start of the segment's data.
  const base = segment.start;

  const seeks = new Map<number, number>();
  let info: Region | null = null;
  let tracks: Region | null = null;
  for (const el of children(head, base, head.length)) {
    if (el.end > head.length || el.id === ID.Cluster) break;
    if (el.id === ID.SeekHead) readSeekHead(head, el, seeks);
    else if (el.id === ID.Info) info = { buf: head, start: el.start, end: el.end };
    else if (el.id === ID.Tracks) tracks = { buf: head, start: el.start, end: el.end };
  }

  tracks ??= await readElementAt(url, base, seeks.get(ID.Tracks), ID.Tracks, timeoutMs);
  info ??= await readElementAt(url, base, seeks.get(ID.Info), ID.Info, timeoutMs);
  const cues = await readElementAt(url, base, seeks.get(ID.Cues), ID.Cues, timeoutMs);
  if (!tracks || !cues) return null;

  const scaleNs = info ? timestampScale(info) : 1_000_000;
  const subtitleTracks = listSubtitleTracks(tracks);
  if (subtitleTracks.length === 0) return null;

  const entries = collectEntries(cues, scaleNs);
  return subtitleTracks.map((track) => ({
    order: track.order,
    codec: track.codec,
    cues: indexToCues(entries.get(track.number) ?? [], track.codec),
  }));
}

/**
 * Turns index entries into line intervals.
 *
 * Text tracks usually carry a duration per entry. PGS tracks do not: each line
 * is two events, one that shows the image and one that clears it, so they are
 * paired up instead.
 */
export function indexToCues(entries: Entry[], codec: string): Cue[] {
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  if (sorted.length > 0 && sorted.every((e) => e.duration !== undefined && e.duration > 0)) {
    return sorted.map((e) => ({
      start: Math.round(e.start),
      end: Math.round(e.start + e.duration!),
      text: "",
    }));
  }
  if (codec === "S_HDMV/PGS") return pairShowClear(sorted.map((e) => e.start));
  return sorted.map((e) => ({
    start: Math.round(e.start),
    end: Math.round(e.start + (e.duration ?? DEFAULT_LINE_MS)),
    text: "",
  }));
}

/**
 * Pairs PGS show and clear events into lines.
 *
 * Counting on strict alternation would let one missing clear event turn every
 * later line into the gap after it. A gap longer than any line can last is
 * taken as the sign of that, and the pairing starts again from the next event.
 */
export function pairShowClear(times: number[]): Cue[] {
  const unique = [...new Set(times)].sort((a, b) => a - b);
  const cues: Cue[] = [];
  let i = 0;
  while (i < unique.length) {
    const start = unique[i]!;
    const next = unique[i + 1];
    if (next !== undefined && next - start <= MAX_LINE_MS) {
      cues.push({ start: Math.round(start), end: Math.round(next), text: "" });
      i += 2;
    } else {
      cues.push({ start: Math.round(start), end: Math.round(start + DEFAULT_LINE_MS), text: "" });
      i += 1;
    }
  }
  return cues;
}

interface Region {
  buf: Buffer;
  start: number;
  end: number;
}

interface Element {
  id: number;
  /** Where the element's data starts. */
  start: number;
  /** Where it ends. Past the buffer when the read cut it short. */
  end: number;
}

async function readRange(url: string, from: number, to: number, timeoutMs: number): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { Range: `bytes=${from}-${to}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 429) {
    await response.body?.cancel();
    throw new RateLimitedError("the file host refused an index read (429 Too Many Requests)");
  }
  // Anything but 206 means the server ignored the range and is about to send
  // the whole file. Give up rather than download gigabytes by accident.
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error(`range request returned ${response.status}, not 206`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function readElementAt(
  url: string,
  base: number,
  position: number | undefined,
  expectedId: number,
  timeoutMs: number,
): Promise<Region | null> {
  if (position === undefined) return null;
  const offset = base + position;
  const header = await readRange(url, offset, offset + 11, timeoutMs);
  const id = readId(header, 0, header.length);
  if (!id || id.id !== expectedId) return null;
  const size = readSize(header, id.len, header.length);
  if (!size || size.unknown || size.value > MAX_ELEMENT_BYTES) return null;

  const headerLength = id.len + size.len;
  const buf = await readRange(url, offset, offset + headerLength + size.value - 1, timeoutMs);
  return { buf, start: headerLength, end: Math.min(buf.length, headerLength + size.value) };
}

/** EBML ids keep their length marker bits, so the raw bytes are the id. */
function readId(b: Buffer, p: number, to: number): { id: number; len: number } | null {
  const first = b[p];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (len > 4 || p + len > to) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[p + i]!;
  return { id, len };
}

function readSize(
  b: Buffer,
  p: number,
  to: number,
): { value: number; len: number; unknown: boolean } | null {
  const first = b[p];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (len > 8 || p + len > to) return null;
  const mask = 0xff >> len;
  let value = first & mask;
  let unknown = value === mask;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[p + i]!;
    if (b[p + i] !== 0xff) unknown = false;
  }
  return { value, len, unknown };
}

function children(b: Buffer, from: number, to: number): Element[] {
  const out: Element[] = [];
  let p = from;
  while (p < to) {
    const id = readId(b, p, to);
    if (!id) break;
    const size = readSize(b, p + id.len, to);
    if (!size) break;
    const start = p + id.len + size.len;
    const end = size.unknown ? to : start + size.value;
    out.push({ id: id.id, start, end });
    if (end > to) break;
    p = end;
  }
  return out;
}

function uint(b: Buffer, from: number, to: number): number {
  let value = 0;
  for (let i = from; i < to; i++) value = value * 256 + b[i]!;
  return value;
}

function readSeekHead(b: Buffer, seekHead: Element, into: Map<number, number>): void {
  for (const seek of children(b, seekHead.start, seekHead.end)) {
    if (seek.id !== ID.Seek) continue;
    let target = 0;
    let position: number | undefined;
    for (const field of children(b, seek.start, seek.end)) {
      if (field.id === ID.SeekID) target = uint(b, field.start, field.end);
      else if (field.id === ID.SeekPosition) position = uint(b, field.start, field.end);
    }
    // The first entry wins; later ones usually point at a second seek table.
    if (target && position !== undefined && !into.has(target)) into.set(target, position);
  }
}

function timestampScale(info: Region): number {
  for (const field of children(info.buf, info.start, info.end)) {
    if (field.id === ID.TimestampScale) return uint(info.buf, field.start, field.end) || 1_000_000;
  }
  return 1_000_000;
}

function listSubtitleTracks(tracks: Region): Array<{ number: number; codec: string; order: number }> {
  const out: Array<{ number: number; codec: string; order: number }> = [];
  for (const entry of children(tracks.buf, tracks.start, tracks.end)) {
    if (entry.id !== ID.TrackEntry) continue;
    let number = 0;
    let type = 0;
    let codec = "";
    for (const field of children(tracks.buf, entry.start, entry.end)) {
      if (field.id === ID.TrackNumber) number = uint(tracks.buf, field.start, field.end);
      else if (field.id === ID.TrackType) type = uint(tracks.buf, field.start, field.end);
      else if (field.id === ID.CodecID) {
        codec = tracks.buf.subarray(field.start, field.end).toString("latin1").replace(/\0+$/, "");
      }
    }
    // Subtitle streams are numbered in track list order, as ffprobe does.
    if (type === TRACK_TYPE_SUBTITLE && number > 0) out.push({ number, codec, order: out.length });
  }
  return out;
}

function collectEntries(cues: Region, scaleNs: number): Map<number, Entry[]> {
  const toMs = (value: number): number => (value * scaleNs) / 1e6;
  const byTrack = new Map<number, Entry[]>();
  for (const point of children(cues.buf, cues.start, cues.end)) {
    if (point.id !== ID.CuePoint || point.end > cues.end) continue;
    let time: number | undefined;
    const positions: Array<{ track: number; duration: number | undefined }> = [];
    for (const field of children(cues.buf, point.start, point.end)) {
      if (field.id === ID.CueTime) time = uint(cues.buf, field.start, field.end);
      else if (field.id === ID.CueTrackPositions) {
        let track = 0;
        let duration: number | undefined;
        for (const inner of children(cues.buf, field.start, field.end)) {
          if (inner.id === ID.CueTrack) track = uint(cues.buf, inner.start, inner.end);
          else if (inner.id === ID.CueDuration) duration = uint(cues.buf, inner.start, inner.end);
        }
        positions.push({ track, duration });
      }
    }
    if (time === undefined) continue;
    for (const position of positions) {
      const list = byTrack.get(position.track) ?? [];
      list.push({
        start: toMs(time),
        duration: position.duration === undefined ? undefined : toMs(position.duration),
      });
      byTrack.set(position.track, list);
    }
  }
  return byTrack;
}
