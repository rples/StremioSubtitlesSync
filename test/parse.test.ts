import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSubtitle, detectFormat } from "../src/subtitles/parse";
import { toSrt, toVtt } from "../src/subtitles/serialize";
import { decodeSubtitle } from "../src/opensubtitles/client";

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "First line",
  "",
  "2",
  "00:01:10,250 --> 00:01:12,000",
  "Second line",
  "with a wrap",
  "",
].join("\r\n");

test("parses SRT with CRLF and multi-line cues", () => {
  const cues = parseSubtitle(SRT);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1000, end: 3500, text: "First line" });
  assert.equal(cues[1]!.start, 70_250);
  assert.equal(cues[1]!.text, "Second line\nwith a wrap");
});

test("parses SRT with a byte order mark and no blank line before the index", () => {
  const cues = parseSubtitle("﻿1\n00:00:02,000 --> 00:00:04,000\nHi\n2\n00:00:05,000 --> 00:00:06,000\nBye\n");
  assert.equal(cues.length, 2);
  assert.equal(cues[0]!.text, "Hi");
  assert.equal(cues[1]!.text, "Bye");
});

test("parses WebVTT, including the hour-less timestamp form", () => {
  const vtt = "WEBVTT\n\n00:01.000 --> 00:03.000\nShort form\n\n00:00:10.500 --> 00:00:12.000\nLong form\n";
  assert.equal(detectFormat(vtt), "vtt");
  const cues = parseSubtitle(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0]!.start, 1000);
  assert.equal(cues[1]!.start, 10_500);
});

test("parses ASS dialogue and drops override tags", () => {
  const ass = [
    "[Script Info]",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:05.10,0:00:07.20,Default,,0,0,0,,{\\pos(10,10)}Hello, there",
    "Dialogue: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,Line\\Nbreak",
  ].join("\n");

  const cues = parseSubtitle(ass);
  assert.equal(cues.length, 2);
  assert.equal(cues[0]!.start, 5100);
  // The comma inside the text must survive the field split.
  assert.equal(cues[0]!.text, "Hello, there");
  assert.equal(cues[1]!.text, "Line\nbreak");
});

test("a padded fraction means milliseconds, not raw digits", () => {
  const cues = parseSubtitle("1\n00:00:01,5 --> 00:00:02,25\nx\n");
  assert.equal(cues[0]!.start, 1500);
  assert.equal(cues[0]!.end, 2250);
});

test("cues survive a round trip through SRT", () => {
  const cues = parseSubtitle(SRT);
  assert.deepEqual(parseSubtitle(toSrt(cues)), cues);
});

test("VTT output escapes an arrow inside cue text", () => {
  const vtt = toVtt([{ start: 0, end: 1000, text: "a --> b" }]);
  const back = parseSubtitle(vtt);
  assert.equal(back.length, 1);
  assert.equal(back[0]!.text, "a -> b");
});

test("falls back to a national code page when the file is not UTF-8", () => {
  // "Zażółć" in windows-1250.
  const bytes = Buffer.from([0x5a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6]);
  assert.equal(decodeSubtitle(bytes, "pl"), "Zażółć");
  // Valid UTF-8 must be left alone.
  assert.equal(decodeSubtitle(Buffer.from("Zażółć", "utf8"), "pl"), "Zażółć");
});
