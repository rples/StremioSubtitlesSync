import type { ResolvedConfig } from "../config";
import { embeddedReference } from "../embedded/reference";
import { fetchSubtitle } from "../providers";
import { align, applyAlignment } from "../subtitles/align";
import { parseSubtitle } from "../subtitles/parse";
import type { Cue } from "../subtitles/types";
import { decodeHint, decodeRef, type FileRef, type VideoHint } from "../urls";
import { TranslationError } from "./config";

export type SourceTiming = "exact" | "synced" | "synced-weak" | "synced-embedded" | "unsynced";
type SourceJob = { file: FileRef; timing: SourceTiming; videoId?: string; release?: string; videoHash?: string; videoSize?: number } & (
  | { kind: "s" }
  | { kind: "x"; anchor: FileRef }
  | { kind: "f"; hint: VideoHint }
);

export function translationUrl(base: string, cfg: string, sourceUrl: string, target: string, timing: SourceTiming, slug: string, ext: string, metadata?: { videoId: string; release?: string; videoHash?: string; videoSize?: number }): string {
  const prefix = `${base}/${cfg}/`;
  if (!sourceUrl.startsWith(prefix)) throw new TranslationError("Invalid translation source URL", 400);
  const sourcePath = sourceUrl.slice(prefix.length).split("/").slice(0, -1).join("/");
  const job = Buffer.from(JSON.stringify({ path: sourcePath, timing, ...metadata }), "utf8").toString("base64url");
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
  const metadata: { videoId?: string; release?: string; videoHash?: string; videoSize?: number } = {};
  if ("videoId" in value && value.videoId !== undefined) {
    if (typeof value.videoId !== "string" || !/^tt\d{1,12}(?::\d{1,3}:\d{1,4})?$/.test(value.videoId)) throw new TranslationError("Bad translation media reference", 400);
    metadata.videoId = value.videoId;
  }
  if ("release" in value && value.release !== undefined) {
    if (typeof value.release !== "string" || value.release.length > 1024 || /[\r\n\x00]/.test(value.release)) throw new TranslationError("Bad translation release reference", 400);
    metadata.release = value.release;
  }
  if ("videoHash" in value && value.videoHash !== undefined) {
    if (typeof value.videoHash !== "string" || !/^[a-fA-F0-9]{16}$/.test(value.videoHash)) throw new TranslationError("Bad translation file hash", 400);
    metadata.videoHash = value.videoHash.toLowerCase();
  }
  if ("videoSize" in value && value.videoSize !== undefined) {
    if (typeof value.videoSize !== "number" || !Number.isSafeInteger(value.videoSize) || value.videoSize <= 0) throw new TranslationError("Bad translation file size", 400);
    metadata.videoSize = value.videoSize;
  }
  const parts = value.path.split("/");
  const file = decodeRef(parts.at(-1));
  if (file) {
    if (parts[0] === "s" && parts.length === 2 && (value.timing === "exact" || value.timing === "unsynced")) {
      return { ...metadata, kind: "s", file, timing: value.timing };
    }
    if (parts[0] === "x" && parts.length === 3 && (value.timing === "synced" || value.timing === "synced-weak")) {
      const anchor = decodeRef(parts[1]);
      if (anchor) return { ...metadata, kind: "x", file, anchor, timing: value.timing };
    }
    if (parts[0] === "f" && parts.length === 3 && value.timing === "synced-embedded") {
      const hint = decodeHint(parts[1]);
      if (hint && ((metadata.videoHash && hint.videoHash && metadata.videoHash !== hint.videoHash.toLowerCase()) ||
          (metadata.videoSize && hint.videoSize && metadata.videoSize !== hint.videoSize))) throw new TranslationError("Conflicting translation file identity", 400);
      if (hint && (!hint.filename || hint.filename.length <= 1024)) return { ...metadata, kind: "f", file, hint, timing: value.timing };
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
