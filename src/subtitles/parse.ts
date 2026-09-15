import type { Cue, SubtitleFormat } from "./types";

/** Matches h:mm:ss,mmm / h:mm:ss.mmm and the hour-less mm:ss.mmm of WebVTT. */
const TIME_RE = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

function parseTime(raw: string): number | null {
  const m = TIME_RE.exec(raw);
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  // "12" means 120ms, not 12ms, so pad the fraction out to milliseconds.
  const ms = Number(frac!.padEnd(3, "0"));
  return Number(h ?? 0) * 3600000 + Number(mm) * 60000 + Number(ss) * 1000 + ms;
}

export function detectFormat(text: string): SubtitleFormat {
  const head = text.slice(0, 2000);
  if (/^﻿?WEBVTT/.test(head)) return "vtt";
  if (/\[Script Info\]/i.test(head) || /^\s*Dialogue:/m.test(head)) return "ass";
  return "srt";
}

/**
 * SRT and WebVTT differ only in the separator and a header, so one scanner
 * handles both: find every line holding "-->", then take the lines under it.
 */
function parseCueList(text: string): Cue[] {
  const lines = text.split("\n");
  const cues: Cue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("-->")) continue;

    const [left, right] = line.split("-->");
    const start = parseTime(left ?? "");
    const end = parseTime(right ?? "");
    if (start === null || end === null) continue;

    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j]!;
      if (next.trim() === "" || next.includes("-->")) break;
      body.push(next);
      j++;
    }
    // Stopping on a "-->" means the line we just took was the next cue's
    // index number, not text. Give it back.
    if (j < lines.length && lines[j]!.includes("-->") && body.length > 0) {
      body.pop();
    }

    cues.push({ start, end: Math.max(end, start), text: body.join("\n").trim() });
    i = j - 1;
  }
  return cues;
}

function parseAss(text: string): Cue[] {
  const lines = text.split("\n");
  const cues: Cue[] = [];
  // Field order is declared per file by the Format: line in [Events].
  let startIdx = 1;
  let endIdx = 2;
  let textIdx = 9;

  for (const raw of lines) {
    const line = raw.trim();
    if (/^Format:/i.test(line)) {
      const fields = line.slice(line.indexOf(":") + 1).split(",").map((f) => f.trim().toLowerCase());
      if (fields.includes("start") && fields.includes("end")) {
        startIdx = fields.indexOf("start");
        endIdx = fields.indexOf("end");
        const t = fields.indexOf("text");
        textIdx = t >= 0 ? t : fields.length - 1;
      }
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;

    const rest = line.slice(line.indexOf(":") + 1);
    // Text is the last field and may itself contain commas, so cap the split.
    const parts = rest.split(",");
    const head = parts.slice(0, textIdx);
    const body = parts.slice(textIdx).join(",");

    const start = parseTime(head[startIdx] ?? "");
    const end = parseTime(head[endIdx] ?? "");
    if (start === null || end === null) continue;

    const plain = body
      .replace(/\{[^}]*\}/g, "") // drop override blocks
      // ASS writes a line break as a literal backslash followed by N or n.
      .replace(/\\N|\\n/g, "\n")
      .trim();
    cues.push({ start, end: Math.max(end, start), text: plain });
  }
  return cues;
}

/** Parses SRT, WebVTT or ASS/SSA into a time-ordered cue list. */
export function parseSubtitle(input: string): Cue[] {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const cues = detectFormat(text) === "ass" ? parseAss(text) : parseCueList(text);
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}
