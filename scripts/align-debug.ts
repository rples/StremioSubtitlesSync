/**
 * Runs the aligner over two dumped cue lists and shows its working.
 * Usage: npx tsx scripts/align-debug.ts <reference.json> <target.json>
 */
import fs from "node:fs";
import { align } from "../src/subtitles/align";
import type { Cue } from "../src/subtitles/types";

function load(file: string): Cue[] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed.cues as Cue[];
}

function bins(cues: Cue[], binMs: number): Uint8Array {
  let maxEnd = 0;
  for (const c of cues) maxEnd = Math.max(maxEnd, c.end);
  const n = Math.floor(maxEnd / binMs) + 2;
  const out = new Uint8Array(n);
  for (const c of cues) {
    const from = Math.max(0, Math.floor(c.start / binMs));
    const to = Math.min(n - 1, Math.floor((Math.max(c.end, c.start + 1) - 1) / binMs));
    for (let i = from; i <= to; i++) out[i] = 1;
  }
  return out;
}

const reference = load(process.argv[2]!);
const target = load(process.argv[3]!);

const BIN = 200;
const refBins = bins(reference, BIN);
const tgtBins = bins(target, BIN);
let refOn = 0;
for (const b of refBins) if (b) refOn++;
let tgtOn = 0;
for (const b of tgtBins) if (b) tgtOn++;

console.log(`reference: ${reference.length} cues, ${refBins.length} bins, ${refOn} on`);
console.log(`target   : ${target.length} cues, ${tgtBins.length} bins, ${tgtOn} on`);
console.log(`target duty cycle: ${((tgtOn / tgtBins.length) * 100).toFixed(1)}%`);

// Overlap at a handful of shifts, computed here independently of the aligner.
console.log("\nshift(s)  matched  rate");
for (const shiftSec of [-60, -30, -10, -5, -2, 0, 2, 5, 10, 30, 60]) {
  const shift = Math.round((shiftSec * 1000) / BIN);
  let matched = 0;
  for (let i = 0; i < tgtBins.length; i++) {
    if (!tgtBins[i]) continue;
    const idx = i + shift;
    if (idx >= 0 && idx < refBins.length && refBins[idx]) matched++;
  }
  console.log(
    `${String(shiftSec).padStart(6)}    ${String(matched).padStart(6)}   ${(matched / refOn).toFixed(3)}`,
  );
}

/**
 * The same comparison using only where each cue STARTS.
 *
 * When a subtitle is on screen 68% of the time, "is someone talking" is true
 * almost always and says nothing. The moment a line appears is sparse and
 * distinctive even then.
 */
const ONSET_BIN = 100;
const TOLERANCE = 3; // bins, so +/- 300ms

const refOnsets = reference.map((c) => Math.floor(c.start / ONSET_BIN));
const tgtSpan = Math.floor(target[target.length - 1]!.start / ONSET_BIN) + TOLERANCE + 2;
const tgtMask = new Uint8Array(tgtSpan);
for (const c of target) {
  const at = Math.floor(c.start / ONSET_BIN);
  for (let d = -TOLERANCE; d <= TOLERANCE; d++) {
    const i = at + d;
    if (i >= 0 && i < tgtSpan) tgtMask[i] = 1;
  }
}
let maskOn = 0;
for (const b of tgtMask) if (b) maskOn++;
console.log(`\nonset mask covers ${((maskOn / tgtSpan) * 100).toFixed(1)}% of the timeline`);
console.log("(that is the rate a wrong shift should score)");

console.log("\nshift(s)  matched/30  rate");
const curve: Array<{ shiftSec: number; rate: number }> = [];
for (let shift = -1200; shift <= 1200; shift++) {
  let matched = 0;
  let support = 0;
  for (const r of refOnsets) {
    const i = r - shift;
    if (i < 0 || i >= tgtSpan) continue;
    support++;
    if (tgtMask[i]) matched++;
  }
  if (support < refOnsets.length * 0.5) continue;
  curve.push({ shiftSec: (shift * ONSET_BIN) / 1000, rate: matched / support });
}
curve.sort((a, b) => b.rate - a.rate);
for (const row of curve.slice(0, 8)) {
  console.log(`${row.shiftSec.toFixed(1).padStart(8)}      ${(row.rate * 30).toFixed(0).padStart(2)}/30      ${row.rate.toFixed(3)}`);
}
const mean = curve.reduce((t, r) => t + r.rate, 0) / curve.length;
const sd = Math.sqrt(curve.reduce((t, r) => t + (r.rate - mean) ** 2, 0) / curve.length);
console.log(`\nbest ${curve[0]!.rate.toFixed(3)} at ${curve[0]!.shiftSec}s, mean ${mean.toFixed(3)}, sd ${sd.toFixed(3)}`);
console.log(`peak stands ${((curve[0]!.rate - mean) / sd).toFixed(1)} deviations above the field`);

console.log("\nalign() says:", JSON.stringify(align(reference, target)));
