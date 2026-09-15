import type { Cue } from "./types";

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function stamp(ms: number, msSep: "," | "."): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3600000);
  const m = Math.floor(clamped / 60000) % 60;
  const s = Math.floor(clamped / 1000) % 60;
  const f = clamped % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${msSep}${pad(f, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  const out: string[] = [];
  cues.forEach((c, i) => {
    out.push(String(i + 1));
    out.push(`${stamp(c.start, ",")} --> ${stamp(c.end, ",")}`);
    out.push(c.text);
    out.push("");
  });
  return out.join("\n");
}

export function toVtt(cues: Cue[]): string {
  const out: string[] = ["WEBVTT", ""];
  for (const c of cues) {
    out.push(`${stamp(c.start, ".")} --> ${stamp(c.end, ".")}`);
    // "-->" inside cue text would be read as a new cue on the way back in.
    out.push(c.text.replace(/-->/g, "->"));
    out.push("");
  }
  return out.join("\n");
}
