import type { ResolvedConfig } from "../config";
import { embeddedReference } from "../embedded/reference";
import { fetchSubtitle } from "../providers";
import { align, applyAlignment } from "../subtitles/align";
import { parseSubtitle } from "../subtitles/parse";
import type { Cue } from "../subtitles/types";
import { decodeHint, decodeRef, type FileRef, type VideoHint } from "../urls";
import { TranslationError } from "./config";

export type SourceTiming = "exact" | "synced" | "synced-weak" | "synced-embedded" | "unsynced";
type SourceJob = { file: FileRef; timing: SourceTiming } & (
  | { kind: "s" }
  | { kind: "x"; anchor: FileRef }
  | { kind: "f"; hint: VideoHint }
);

export function translationUrl(base: string, cfg: string, sourceUrl: string, target: string, timing: SourceTiming, slug: string, ext: string): string {
  const prefix = `${base}/${cfg}/`;
  if (!sourceUrl.startsWith(prefix)) throw new TranslationError("Invalid translation source URL", 400);
  const sourcePath = sourceUrl.slice(prefix.length).split("/").slice(0, -1).join("/");
  const job = Buffer.from(JSON.stringify({ path: sourcePath, timing }), "utf8").toString("base64url");
  return `${base}/${cfg}/t/${target}/${job}/${slug}.${ext}`;
}

export function parseSourceJob(token: string): SourceJob {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(token)) throw new TranslationError("Bad translation source reference", 400);
  let value: unknown;
  try { value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); }
  catch { throw new TranslationError("Bad translation source reference", 400); }
  if (!value || typeof value !== "object" || !("path" in value) || !("timing" in value) ||
      typeof value.path !== "string" || typeof value.timing !== "string") {
    throw new TranslationError("Bad translation source reference", 400);
  }
  const parts = value.path.split("/");
  const file = decodeRef(parts.at(-1));
  if (file) {
    if (parts[0] === "s" && parts.length === 2 && (value.timing === "exact" || value.timing === "unsynced")) {
      return { kind: "s", file, timing: value.timing };
    }
    if (parts[0] === "x" && parts.length === 3 && (value.timing === "synced" || value.timing === "synced-weak")) {
      const anchor = decodeRef(parts[1]);
      if (anchor) return { kind: "x", file, anchor, timing: value.timing };
    }
    if (parts[0] === "f" && parts.length === 3 && value.timing === "synced-embedded") {
      const hint = decodeHint(parts[1]);
      if (hint && (!hint.filename || hint.filename.length <= 1024)) return { kind: "f", file, hint, timing: value.timing };
    }
  }
  throw new TranslationError("Bad translation source reference", 400);
}

async function cuesFor(config: ResolvedConfig, file: FileRef): Promise<Cue[]> {
  const text = await fetchSubtitle(config, file);
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new TranslationError("Translation source is too large", 400);
  const cues = parseSubtitle(text);
  if (!cues.length) throw new TranslationError("Translation source has no subtitle cues");
  return cues;
}

/** Resolve only known subtitle operations, never URLs, files or recursive jobs. */
export async function sourceCues(config: ResolvedConfig, job: SourceJob): Promise<Cue[]> {
  if (job.timing === "unsynced" && !config.includeUnsynced) throw new TranslationError("Unsynced translation sources are disabled", 403);
  const target = await cuesFor(config, job.file);
  if (job.kind === "s") return target;
  const reference = job.kind === "x" ? await cuesFor(config, job.anchor) : await embeddedReference(job.hint, config);
  if (!reference) throw new TranslationError("Translation timing reference is unavailable", 503, 30);
  const result = align(reference, target);
  if (!result.applied) throw new TranslationError("Translation source could not be confidently aligned", 503, 30);
  return applyAlignment(target, result);
}
