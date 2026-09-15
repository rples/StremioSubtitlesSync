import { test } from "node:test";
import assert from "node:assert/strict";
import { align, applyAlignment } from "../src/subtitles/align";
import type { Cue } from "../src/subtitles/types";

/** Deterministic pseudo-random generator, so a failure is always reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A plausible two hour dialogue track. */
function makeReference(seed = 42, count = 900): Cue[] {
  const rand = rng(seed);
  const cues: Cue[] = [];
  let t = 12_000;
  for (let i = 0; i < count; i++) {
    const dur = 900 + Math.floor(rand() * 3200);
    cues.push({ start: t, end: t + dur, text: `line ${i}` });
    t += dur + 200 + Math.floor(rand() * 5000);
  }
  return cues;
}

function shift(cues: Cue[], ms: number): Cue[] {
  return cues.map((c) => ({ ...c, start: c.start + ms, end: c.end + ms }));
}

function scale(cues: Cue[], ratio: number): Cue[] {
  return cues.map((c) => ({
    ...c,
    start: Math.round(c.start * ratio),
    end: Math.round(c.end * ratio),
  }));
}

/** Drops and jitters cues, the way a different translation of the same film differs. */
function translationOf(cues: Cue[], seed = 7): Cue[] {
  const rand = rng(seed);
  return cues
    .filter(() => rand() > 0.12)
    .map((c) => {
      const j = Math.round((rand() - 0.5) * 300);
      return { start: c.start + j, end: c.end + j, text: c.text };
    });
}

test("finds a plain positive offset", () => {
  const ref = makeReference();
  const target = shift(translationOf(ref), 8_300);
  const result = align(ref, target);

  assert.equal(result.applied, true);
  assert.equal(result.ratio, 1);
  assert.ok(Math.abs(result.offsetMs + 8_300) <= 60, `offset was ${result.offsetMs}`);
  assert.ok(result.confidence > 0.7, `confidence was ${result.confidence}`);
});

test("finds a plain negative offset", () => {
  const ref = makeReference(101);
  const target = shift(translationOf(ref, 3), -4_120);
  const result = align(ref, target);

  assert.equal(result.applied, true);
  assert.ok(Math.abs(result.offsetMs - 4_120) <= 60, `offset was ${result.offsetMs}`);
});

test("finds a 25 -> 23.976 fps stretch", () => {
  const ref = makeReference(5);
  const ratio = 25 / (24000 / 1001);
  const target = translationOf(scale(ref, ratio), 9);
  const result = align(ref, target);

  assert.equal(result.applied, true);
  assert.ok(Math.abs(result.ratio - 1 / ratio) < 0.001, `ratio was ${result.ratio}`);

  // The real test: after applying, cues must land on the reference.
  // Lines were dropped, so pair them up by text rather than by position.
  const byText = new Map(ref.map((c) => [c.text, c.start]));
  const fixed = applyAlignment(target, result);
  const drift = fixed
    .map((c) => {
      const refStart = byText.get(c.text);
      return refStart === undefined ? null : Math.abs(c.start - refStart);
    })
    .filter((d): d is number => d !== null);

  const median = drift.sort((a, b) => a - b)[Math.floor(drift.length / 2)]!;
  assert.ok(median < 400, `median drift was ${median}ms`);
});

test("applying the result lands cues on the reference", () => {
  const ref = makeReference(77);
  const offset = 15_000;
  const target = shift(ref, offset);
  const fixed = applyAlignment(target, align(ref, target));

  for (let i = 0; i < ref.length; i++) {
    assert.ok(Math.abs(fixed[i]!.start - ref[i]!.start) <= 40);
  }
});

test("refuses to guess on unrelated subtitles", () => {
  const ref = makeReference(1, 300);
  const unrelated = makeReference(999, 300);
  const result = align(ref, unrelated);
  assert.ok(
    !result.applied || result.confidence < 0.6,
    `bogus match with confidence ${result.confidence}`,
  );
});

test("leaves timings alone when there is nothing to work with", () => {
  const ref = makeReference();
  const result = align(ref, [{ start: 0, end: 1000, text: "hi" }]);
  assert.equal(result.applied, false);
  const cues: Cue[] = [{ start: 500, end: 900, text: "hi" }];
  assert.deepEqual(applyAlignment(cues, result), cues);
});
