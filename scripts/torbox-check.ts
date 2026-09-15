/**
 * Live check of the TorBox path: npm run check:torbox
 * Prints nothing that could leak the API key or a signed CDN link.
 */
import { TorBoxSource } from "../src/sources/torbox";
import { rankCandidates, isVideoFile } from "../src/sources/match";
import { hashRemoteFile } from "../src/embedded/oshash";
import { probeMedia } from "../src/embedded/ffprobe";

const KEY = (process.env.TORBOX_API_KEY ?? "").trim();
const API = "https://api.torbox.app/v1/api";

function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.slice(0, 40)}... (${u.searchParams.size} params)`;
  } catch {
    return "<unparseable url>";
  }
}

async function main(): Promise<void> {
  if (!KEY) {
    console.log("NO KEY in env");
    return;
  }
  console.log(`key present: ${KEY.length} chars, ends ...${KEY.slice(-4)}`);

  // --- 1. Raw schema check, the part I could not verify without an account ---
  for (const kind of ["torrents", "usenet", "webdl"]) {
    try {
      const res = await fetch(`${API}/${kind}/mylist?limit=1000&offset=0`, {
        headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      const body: any = await res.json();
      const items = Array.isArray(body?.data) ? body.data : [];
      console.log(`\n=== ${kind}/mylist -> HTTP ${res.status}, ${items.length} items`);
      if (items.length > 0) {
        const first = items[0];
        console.log(`  item keys: ${Object.keys(first).join(", ")}`);
        const files = Array.isArray(first.files) ? first.files : [];
        console.log(`  files on first item: ${files.length}`);
        if (files.length > 0) {
          console.log(`  file keys: ${Object.keys(files[0]).join(", ")}`);
          console.log(`  sample file: id=${files[0].id} size=${files[0].size} name=${files[0].short_name ?? files[0].name}`);
        }
      }
    } catch (e) {
      console.log(`\n=== ${kind}/mylist FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }

  // --- 2. Does our client see the same files? ---
  const source = new TorBoxSource(KEY);
  const all: any[] = [];
  for (const kind of ["torrents", "usenet", "webdl"]) {
    try {
      const res = await fetch(`${API}/${kind}/mylist?limit=1000&offset=0`, {
        headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      const body: any = await res.json();
      for (const item of body?.data ?? []) {
        for (const f of item.files ?? []) {
          all.push({
            containerId: item.id,
            fileId: f.id,
            name: String(f.short_name ?? f.name ?? ""),
            size: Number(f.size ?? 0),
            kind,
            torboxHash: typeof f.opensubtitles_hash === "string" ? f.opensubtitles_hash : undefined,
          });
        }
      }
    } catch {
      /* already reported above */
    }
  }

  const videos = all.filter((f) => isVideoFile(f.name, f.size));
  console.log(`\n=== ${all.length} files total, ${videos.length} usable videos`);
  if (videos.length === 0) {
    console.log("nothing to test against");
    return;
  }

  videos.sort((a, b) => a.size - b.size);
  for (const v of videos.slice(0, 5)) {
    console.log(`  ${(v.size / 1e9).toFixed(2)} GB  ${v.name}`);
  }

  // Smallest one, to keep the traffic for the window read as low as possible.
  const pick = videos[0];
  console.log(`\n=== testing against: ${pick.name} (${(pick.size / 1e9).toFixed(2)} GB, ${pick.kind})`);

  // --- 3. The real resolve path, matching on size like the addon does ---
  const resolved = await source.resolve({
    filename: pick.name,
    videoSize: pick.size,
    videoHash: undefined,
  });
  console.log(`resolve() returned ${resolved.length} candidate(s)`);
  if (resolved.length === 0) {
    console.log("FAILED: no download link");
    return;
  }
  const file = resolved[0]!;
  console.log(`  link: ${redact(file.url)}`);

  // --- 4. Hash over two range requests ---
  const started = Date.now();
  const hash = await hashRemoteFile(file.url, file.size);
  console.log(`\n=== oshash: ${hash ?? "FAILED (no 206 / short read)"} in ${Date.now() - started}ms`);

  // --- 5. Track listing (header read only) ---
  const t0 = Date.now();
  const media = await probeMedia(file.url);
  if (!media) {
    console.log("=== probeMedia FAILED");
    return;
  }
  console.log(`\n=== duration ${Math.round(media.durationSeconds)}s, ${media.tracks.length} subtitle track(s), probed in ${Date.now() - t0}ms`);
  for (const t of media.tracks) {
    console.log(`  s:${t.order} ${t.codec} lang=${t.language ?? "?"} forced=${t.forced} bitmap=${t.bitmap}`);
  }
  const bitrate = (file.size * 8) / Math.max(1, media.durationSeconds);
  console.log(`  bitrate ~${(bitrate / 1e6).toFixed(1)} Mbps -> 120s of windows is about ${Math.round((bitrate * 120) / 8 / 1e6)} MB`);

  // --- 6. Does TorBox's own hash agree with ours? ---
  console.log(`
=== hash cross-check`);
  console.log(`  ours   : ${hash}`);
  console.log(`  torbox : ${pick.torboxHash ?? "(not provided)"}`);
  console.log(`  agree  : ${hash === pick.torboxHash}`);

  // --- 7. The actual windowed read ---
  const { planIntervals, readSubtitleTimings } = await import("../src/embedded/ffprobe");
  const { pickTrack } = await import("../src/embedded/reference");
  const track = pickTrack(media.tracks, ["en", "pl"]);
  console.log(`
=== reading windows from track s:${track?.order} (${track?.codec})`);
  const intervals = planIntervals(media.durationSeconds, 6, 20);
  const t1 = Date.now();
  const cues = await readSubtitleTimings(file.url, track!.order, intervals);
  console.log(`  ${cues.length} cues in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`  first: ${JSON.stringify(cues[0])}`);
  console.log(`  last : ${JSON.stringify(cues[cues.length - 1])}`);
  const spread = cues.length > 1 ? (cues[cues.length - 1]!.start - cues[0]!.start) / 1000 : 0;
  console.log(`  spread across ${Math.round(spread)}s of a ${Math.round(media.durationSeconds)}s episode`);
}

main().catch((e) => console.error("FAILED:", e));
