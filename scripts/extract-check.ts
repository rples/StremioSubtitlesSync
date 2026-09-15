/**
 * Reads a real timing reference out of a file in the account.
 * PROBE_MATCH picks the file, TRACK forces a subtitle track,
 * WINDOWS / SECONDS control how much is read.
 */
import { TorBoxSource } from "../src/sources/torbox";
import { probeMedia, planIntervals, readSubtitleTimings } from "../src/embedded/ffprobe";
import { pickTrack } from "../src/embedded/reference";

const KEY = (process.env.TORBOX_API_KEY ?? "").trim();
const API = "https://api.torbox.app/v1/api";
const WANT = (process.env.PROBE_MATCH ?? "").toLowerCase();
const WINDOWS = Number(process.env.WINDOWS ?? 6);
const SECONDS = Number(process.env.SECONDS ?? 20);
const FORCE_TRACK = process.env.TRACK ? Number(process.env.TRACK) : undefined;

async function main(): Promise<void> {
  const res = await fetch(`${API}/torrents/mylist?limit=1000&offset=0`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  const body: any = await res.json();
  const files: any[] = [];
  for (const item of body.data ?? []) {
    for (const f of item.files ?? []) {
      const name = String(f.short_name ?? f.name ?? "");
      if (!/\.(mkv|mp4)$/i.test(name)) continue;
      if (WANT && !name.toLowerCase().includes(WANT)) continue;
      files.push({ name, size: Number(f.size), hash: f.opensubtitles_hash });
    }
  }
  files.sort((a, b) => a.size - b.size);
  const f = files[0];
  if (!f) { console.log("no file matched"); return; }

  const [file] = await new TorBoxSource(KEY).resolve({
    filename: f.name, videoSize: f.size, videoHash: f.hash,
  });
  if (!file) { console.log("no link"); return; }

  const media = await probeMedia(file.url);
  if (!media) { console.log("probe failed"); return; }

  const track = FORCE_TRACK !== undefined
    ? media.tracks.find((t) => t.order === FORCE_TRACK)
    : pickTrack(media.tracks, ["en", "pl"]);
  if (!track) { console.log("no track"); return; }

  const mbps = (f.size * 8) / media.durationSeconds / 1e6;
  const intervals = planIntervals(media.durationSeconds, WINDOWS, SECONDS);
  const sampled = intervals.reduce((t, i) => t + i.durationSeconds, 0);
  console.log(`file    : ${f.name}`);
  console.log(`verified: ${file.verified} (hash from TorBox matched)`);
  console.log(`track   : s:${track.order} ${track.codec} lang=${track.language ?? "?"} bitmap=${track.bitmap}`);
  console.log(`reading : ${intervals.length} x ${SECONDS}s = ${sampled}s at ${mbps.toFixed(1)} Mbps -> about ${Math.round((mbps * sampled) / 8)} MB`);

  const t0 = Date.now();
  const cues = await readSubtitleTimings(file.url, track.order, intervals);
  console.log("");
  console.log("per-window cue counts:");
  for (const iv of intervals) {
    const from = iv.startSeconds * 1000;
    const to = (iv.startSeconds + iv.durationSeconds) * 1000;
    const inWin = cues.filter((c) => c.start >= from && c.start <= to + iv.durationSeconds * 250);
    const onMs = inWin.reduce((t, c) => t + (c.end - c.start), 0);
    console.log(`  ${Math.round(iv.startSeconds)}s..${Math.round(iv.startSeconds + iv.durationSeconds)}s : ${inWin.length} cues, ${Math.round(onMs / 1000)}s of speech`);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nRESULT  : ${cues.length} cues in ${secs}s`);
  if (cues.length > 0) {
    const spread = (cues[cues.length - 1]!.start - cues[0]!.start) / 1000;
    console.log(`  first : ${(cues[0]!.start / 1000).toFixed(1)}s`);
    console.log(`  last  : ${(cues[cues.length - 1]!.start / 1000).toFixed(1)}s`);
    console.log(`  spread: ${Math.round(spread)}s of a ${Math.round(media.durationSeconds)}s film`);
  }
}
main().catch((e) => console.error("FAILED:", e));
