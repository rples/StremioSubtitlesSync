/**
 * Lists the subtitle tracks of a few files in the account, cheaply.
 * Header reads only: npm run check:tracks
 */
import { TorBoxSource } from "../src/sources/torbox";
import { probeMedia } from "../src/embedded/ffprobe";
import { pickTrack } from "../src/embedded/reference";

const KEY = (process.env.TORBOX_API_KEY ?? "").trim();
const API = "https://api.torbox.app/v1/api";
const WANT = (process.env.PROBE_MATCH ?? "").toLowerCase();

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

  const source = new TorBoxSource(KEY);
  for (const f of files.slice(0, Number(process.env.PROBE_LIMIT ?? 4))) {
    const [resolved] = await source.resolve({
      filename: f.name, videoSize: f.size, videoHash: f.hash,
    });
    if (!resolved) { console.log(`\n${f.name}\n  no link`); continue; }
    const media = await probeMedia(resolved.url);
    if (!media) { console.log(`\n${f.name}\n  probe failed`); continue; }
    const chosen = pickTrack(media.tracks, ["en", "pl"]);
    const mbps = (f.size * 8) / Math.max(1, media.durationSeconds) / 1e6;
    console.log(`\n${f.name}`);
    console.log(`  ${(f.size / 1e9).toFixed(2)}GB  ${Math.round(media.durationSeconds)}s  ${mbps.toFixed(1)} Mbps  -> 120s of windows ~${Math.round((mbps * 120) / 8)} MB`);
    console.log(`  hash=${f.hash} verified=${resolved.verified}`);
    console.log(`  tracks: ${media.tracks.map((t) => `s:${t.order}=${t.codec}/${t.language ?? "?"}${t.forced ? "/forced" : ""}`).join(" ")}`);
    console.log(`  chosen: s:${chosen?.order} ${chosen?.codec} bitmap=${chosen?.bitmap}`);
  }
}
main().catch((e) => console.error("FAILED:", e));
