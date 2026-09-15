import { releaseScore } from "../picker";
import type { FileHint } from "./types";

/** One file inside a debrid account, before we know how to download it. */
export interface CandidateFile {
  containerId: number;
  fileId: number;
  name: string;
  size: number;
  /** Which list it came from: torrents, usenet or web downloads. */
  kind: string;
  /**
   * The OpenSubtitles hash, when the source already knows it. TorBox computes
   * and stores this per file, and it agrees with ours byte for byte, so when it
   * is present there is nothing left to guess about which file this is.
   */
  hash?: string | undefined;
}

const VIDEO_EXTENSIONS = new Set([
  "mkv", "mp4", "avi", "m4v", "mov", "ts", "m2ts", "webm", "mpg", "mpeg", "wmv",
]);

/** Sample files and extras are never the feature, whatever their name says. */
const MIN_VIDEO_BYTES = 50 * 1024 * 1024;

export function isVideoFile(name: string, size: number): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  if (!VIDEO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) return false;
  if (size < MIN_VIDEO_BYTES) return false;
  return !/\bsample\b/i.test(name);
}

/**
 * Ranks the files that might be the one Stremio is playing.
 *
 * Byte size is the strongest signal by far: two different encodes are never the
 * same number of bytes, so an exact match is almost certainly the same file.
 * The name only breaks ties, and only matters when several files share a size
 * or when no size was sent at all.
 */
export function rankCandidates(files: CandidateFile[], hint: FileHint): CandidateFile[] {
  const usable = files.filter((f) => isVideoFile(f.name, f.size));

  const scored = usable.map((file) => {
    const hashMatch =
      hint.videoHash !== undefined && file.hash !== undefined && file.hash === hint.videoHash;
    const exactSize = hint.videoSize !== undefined && file.size === hint.videoSize;
    const nameScore = hint.filename ? releaseScore(hint.filename, file.name) : 0;
    return { file, hashMatch, exactSize, nameScore };
  });

  // Without a hash or a size to match on, a weak name guess is not worth a
  // round trip.
  const worthTrying = scored.filter(
    (entry) =>
      entry.hashMatch ||
      entry.exactSize ||
      (hint.videoSize === undefined && entry.nameScore >= 0.5),
  );

  worthTrying.sort((a, b) => {
    if (a.hashMatch !== b.hashMatch) return a.hashMatch ? -1 : 1;
    if (a.exactSize !== b.exactSize) return a.exactSize ? -1 : 1;
    return b.nameScore - a.nameScore;
  });

  return worthTrying.map((entry) => entry.file);
}
