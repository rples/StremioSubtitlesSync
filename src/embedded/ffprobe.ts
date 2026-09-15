import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../log";
import type { Cue } from "../subtitles/types";

const run = promisify(execFile);

const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";
const MAX_OUTPUT = 32 * 1024 * 1024;
/** How many windows to read at once. Debrid links refuse more than a couple. */
const WINDOW_CONCURRENCY = Math.max(1, Number(process.env.EMBEDDED_CONCURRENCY ?? 2));
/** How long to wait before each retry of a read the host refused with 429. */
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

/**
 * The file host refused a read because too many were open at once.
 *
 * This says nothing about the file, so it must never be remembered as "no
 * usable subtitles". `cues` holds whatever the reads that got through returned.
 */
export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly cues: Cue[] = [],
  ) {
    super(message);
    this.name = "RateLimitedError";
  }
}

/** ffprobe reports it as "Server returned 429 Too Many Requests". */
function isRateLimited(error: unknown): boolean {
  return error instanceof Error && /\b429\b|Too Many Requests/i.test(error.message);
}

/**
 * ffprobe puts the whole command line in its error, and a debrid link carries
 * its access token in the query string. Keep the token out of the log.
 */
function redact(message: string): string {
  return message.replace(/(https?:\/\/[^\s?]+)\?\S+/g, "$1?<redacted>");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SubtitleTrack {
  /** Index among subtitle streams only. This is what -select_streams s:N wants. */
  order: number;
  codec: string;
  language: string | undefined;
  forced: boolean;
  /** True for image-based tracks (PGS, VobSub) that carry no readable text. */
  bitmap: boolean;
}

export interface MediaInfo {
  durationSeconds: number;
  tracks: SubtitleTrack[];
}

const BITMAP_CODECS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ffprobe(args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await run(FFPROBE, args, {
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
  });
  return stdout;
}

/**
 * Like ffprobe(), but a timeout keeps whatever was printed before the kill.
 *
 * This is the safety valve for the behaviour described on readSubtitleTimings:
 * a window over a near-empty track never finishes on its own, and the packets
 * it did emit first are still worth having.
 */
async function ffprobePartial(args: string[], timeoutMs: number): Promise<string> {
  try {
    return await ffprobe(args, timeoutMs);
  } catch (error) {
    const partial = (error as { stdout?: string }).stdout;
    if (typeof partial === "string" && partial.length > 0) return partial;
    if ((error as { killed?: boolean }).killed) return "";
    throw error;
  }
}

/**
 * Lists the subtitle tracks and the duration.
 *
 * Only the container header is read, so this stays small even on a remote file
 * and is cheap enough to run while building the subtitle list.
 */
export async function probeMedia(url: string, timeoutMs = 45_000): Promise<MediaInfo | null> {
  try {
    const stdout = await ffprobe(
      [
        "-v", "error",
        "-select_streams", "s",
        "-show_entries",
        "format=duration:stream=codec_name,codec_type:stream_tags=language:stream_disposition=forced",
        "-of", "json",
        url,
      ],
      timeoutMs,
    );

    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) return null;

    const format = isRecord(parsed["format"]) ? parsed["format"] : {};
    const durationSeconds = Number(format["duration"] ?? 0);

    const streams = Array.isArray(parsed["streams"]) ? parsed["streams"] : [];
    const tracks: SubtitleTrack[] = [];
    streams.filter(isRecord).forEach((stream, order) => {
      const codec = String(stream["codec_name"] ?? "unknown").toLowerCase();
      const tags = isRecord(stream["tags"]) ? stream["tags"] : {};
      const disposition = isRecord(stream["disposition"]) ? stream["disposition"] : {};
      const language = tags["language"] ? String(tags["language"]).toLowerCase() : undefined;
      tracks.push({
        order,
        codec,
        language,
        forced: Number(disposition["forced"] ?? 0) === 1,
        bitmap: BITMAP_CODECS.has(codec),
      });
    });

    return { durationSeconds, tracks };
  } catch (error) {
    // A refusal is not an answer about the file, so it must not be cached as
    // "no subtitle track".
    if (isRateLimited(error)) {
      throw new RateLimitedError("the file host refused the probe (429 Too Many Requests)");
    }
    log.warn(
      `ffprobe could not read the media: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
    return null;
  }
}

/** One stretch of the file to read, in seconds. */
export interface Interval {
  startSeconds: number;
  durationSeconds: number;
}

/**
 * Reads subtitle packet timings for the given intervals.
 *
 * Packets are read straight out of the container without decoding, so this
 * works the same for text tracks and for image tracks like PGS: we only want to
 * know when something was on screen, never what it said.
 *
 * ffprobe seeks to each interval by HTTP range, so the cost is roughly the
 * total interval length times the file's bitrate, not the size of the file.
 */
export interface ReadOptions {
  perWindowTimeoutMs?: number;
  /** Wait before each retry of a refused window. The length is the retry count. */
  retryDelaysMs?: number[];
}

/**
 * Throws RateLimitedError when a window is still refused after its retries,
 * so a busy host is never mistaken for a track with nothing in it.
 */
export async function readSubtitleTimings(
  url: string,
  track: number,
  intervals: Interval[],
  { perWindowTimeoutMs = 45_000, retryDelaysMs = RETRY_DELAYS_MS }: ReadOptions = {},
): Promise<Cue[]> {
  if (intervals.length === 0) return [];

  // One process per window, each on its own leash, a couple at a time.
  //
  // ffprobe does not stop at the end of a -read_intervals window if the
  // selected stream has no packet in it. It keeps reading forward until it
  // finds one, which on a near-empty subtitle track means streaming most of the
  // file. Verified: asking for 20s to 40s of a file whose only cue sits at 200s
  // returns that 200s cue. Passing all the windows to a single ffprobe would
  // let one barren window run away with the whole budget, so each gets its own
  // process and its own timeout, and anything it read past its window is
  // dropped.
  //
  // The concurrency cap is not about this machine. A debrid download link
  // usually allows only a couple of connections at once, and opening one per
  // window got them refused outright. The player streams the same file at the
  // same time, so even two can be one too many: after the first 429 the rest of
  // the windows go one at a time, and the refused one is retried after a pause.
  let concurrency = WINDOW_CONCURRENCY;
  let refused = 0;

  const probeWindow = async (start: number, duration: number): Promise<string | null> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await ffprobePartial(
          [
            "-v", "error",
            "-select_streams", `s:${track}`,
            "-show_entries", "packet=pts_time,duration_time",
            "-of", "csv=p=0",
            "-read_intervals", `${start}%+${duration}`,
            url,
          ],
          perWindowTimeoutMs,
        );
      } catch (error) {
        if (!isRateLimited(error)) {
          // One broken window is not worth losing the other five over, but it
          // does weaken the reference, so say so rather than hiding it.
          log.warn(
            `window at ${start}s failed: ${redact(error instanceof Error ? error.message : String(error))}`,
          );
          return null;
        }

        concurrency = 1;
        const wait = retryDelaysMs[attempt];
        if (wait === undefined) {
          log.warn(`window at ${start}s still refused after ${attempt} retries (429 Too Many Requests)`);
          refused++;
          return null;
        }
        log.warn(`window at ${start}s refused (429 Too Many Requests), retrying in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  };

  const readWindow = async (interval: Interval): Promise<Cue[]> => {
    const start = Math.max(0, Math.floor(interval.startSeconds));
    const duration = Math.max(1, Math.floor(interval.durationSeconds));
    const stdout = await probeWindow(start, duration);
    if (stdout === null) return [];

    // A little past the end is fine: a cue can start just inside the window
    // and the packet timing is still genuine. Far past it is the runaway.
    const from = start * 1000;
    const to = (start + duration) * 1000 + duration * 250;
    const cues = parseTimings(stdout).filter((cue) => cue.start >= from && cue.start <= to);

    if (cues.length === 0) {
      log.info(`window at ${start}s held no subtitles`);
      return [];
    }
    if (isSaturated(cues, duration)) {
      log.info(
        `window at ${start}s looks like karaoke or typesetting ` +
          `(${cues.length} cues in ${duration}s), skipping it`,
      );
      return [];
    }
    return cues;
  };

  const collected: Cue[] = [];
  for (let i = 0; i < intervals.length; ) {
    const batch = intervals.slice(i, i + concurrency);
    i += batch.length;
    const results = await Promise.all(batch.map(readWindow));
    for (const cues of results) collected.push(...cues);
  }

  const cues = normalize(collected);
  if (refused > 0) {
    throw new RateLimitedError(
      `the file host refused ${refused} of ${intervals.length} reads (429 Too Many Requests)`,
      cues,
    );
  }
  return cues;
}

/** Milliseconds where at least one cue is on screen, counting overlaps once. */
export function coveredMs(cues: Cue[]): number {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  let total = 0;
  let openFrom = -1;
  let openTo = -1;
  for (const cue of sorted) {
    if (cue.start > openTo) {
      if (openFrom >= 0) total += openTo - openFrom;
      openFrom = cue.start;
      openTo = cue.end;
    } else if (cue.end > openTo) {
      openTo = cue.end;
    }
  }
  if (openFrom >= 0) total += openTo - openFrom;
  return total;
}

/**
 * True when a window is a solid block of text rather than dialogue.
 *
 * Anime subtitle tracks carry karaoke and typesetting in with the dialogue, and
 * an opening song emits one event per syllable: 144 cues in twelve seconds,
 * covering every moment of it. Such a window says nothing about when anyone
 * spoke, so it cannot help align anything, and because it is always on it
 * matches any shift equally. Left in, it drowns out the windows that do carry
 * information.
 */
export function isSaturated(cues: Cue[], windowSeconds: number): boolean {
  if (cues.length < 8 || windowSeconds <= 0) return false;
  const perSecond = cues.length / windowSeconds;
  const covered = coveredMs(cues) / (windowSeconds * 1000);
  // Nobody speaks three lines a second, and real dialogue leaves gaps.
  return perSecond > 3 || covered > 0.9;
}

/**
 * Sorts cues and drops repeats.
 *
 * Windows can overlap on a short film, and ffprobe reports the packets in each.
 * The same cue counted twice would weight that stretch of the timeline double.
 */
function normalize(cues: Cue[]): Cue[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const unique: Cue[] = [];
  for (const cue of sorted) {
    const previous = unique[unique.length - 1];
    if (previous && previous.start === cue.start) continue;
    unique.push(cue);
  }
  return unique;
}

/** Turns ffprobe's "pts_time,duration_time" CSV into cues. Text is not needed. */
export function parseTimings(stdout: string): Cue[] {
  const cues: Cue[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const [startRaw, durationRaw] = trimmed.split(",");
    const start = Number(startRaw);
    if (!Number.isFinite(start) || start < 0) continue;

    const duration = Number(durationRaw);
    // A missing or absurd duration still gives a usable "someone spoke here"
    // mark, so fall back to a typical subtitle length rather than dropping it.
    const span = Number.isFinite(duration) && duration > 0 && duration < 30 ? duration : 2;

    cues.push({
      start: Math.round(start * 1000),
      end: Math.round((start + span) * 1000),
      text: "",
    });
  }
  return normalize(cues);
}

/**
 * Spreads the sample windows across the film.
 *
 * The windows are pulled in from the very start and end, where logos, credits
 * and silence make for a poor reference. Spreading them wide matters: a long
 * baseline is what lets the aligner tell a frame rate stretch from a plain
 * offset.
 */
export function planIntervals(
  durationSeconds: number,
  count: number,
  windowSeconds: number,
): Interval[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];

  // Opening and closing songs sit just inside the old 6% margins, and they are
  // exactly the karaoke that has to be thrown away later. Starting further in
  // costs almost no baseline and avoids most of them.
  const from = durationSeconds * 0.11;
  const to = durationSeconds * 0.89 - windowSeconds;
  if (to <= from) {
    return [{ startSeconds: 0, durationSeconds: Math.min(windowSeconds, durationSeconds) }];
  }

  const slots = Math.max(1, count);
  const step = slots === 1 ? 0 : (to - from) / (slots - 1);
  const intervals: Interval[] = [];
  for (let i = 0; i < slots; i++) {
    intervals.push({ startSeconds: from + step * i, durationSeconds: windowSeconds });
  }
  return intervals;
}
