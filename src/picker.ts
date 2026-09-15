import type { OsSubtitle } from "./opensubtitles/types";

/**
 * Choosing the anchor is the whole trick.
 *
 * An anchor is a subtitle whose timing is known to fit the exact video file the
 * user is watching. Every other subtitle can then be aligned to it without ever
 * touching the video. OpenSubtitles tells us this directly through
 * `moviehash_match`: the hash covers the file's size and two 64 KiB chunks, so a
 * match means the uploader had this very file.
 *
 * When no hash matches, the release name is the next best evidence. It is
 * weaker, so it is reported as such rather than passed off as certain.
 */

export type AnchorTier = "hash" | "release";

export interface Anchor {
  subtitle: OsSubtitle;
  tier: AnchorTier;
}

/** Tokens that say nothing about which release a file is. */
const NOISE = new Set([
  "the", "a", "an", "and", "of", "mkv", "mp4", "avi", "srt", "sub", "x", "v2",
]);

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !NOISE.has(t));
}

/**
 * How strongly a subtitle's release name matches the video filename, 0..1.
 *
 * Jaccard overlap of the tokens, with a bonus when the trailing token matches:
 * that is usually the release group, and two files from the same group at the
 * same resolution almost always share timing.
 */
export function releaseScore(filename: string, release: string): number {
  if (!filename || !release) return 0;

  const a = tokenize(filename);
  const b = tokenize(release);
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;

  const union = new Set([...setA, ...setB]).size;
  const jaccard = shared / union;

  const groupA = a[a.length - 1];
  const groupB = b[b.length - 1];
  const groupBonus = groupA && groupA === groupB ? 0.25 : 0;

  return Math.min(1, jaccard + groupBonus);
}

/** Higher is better. Used to order candidates inside one language. */
function quality(subtitle: OsSubtitle): number {
  let score = Math.log10(subtitle.downloadCount + 1) * 10;
  score += subtitle.ratings;
  if (subtitle.fromTrusted) score += 8;
  if (subtitle.machineTranslated) score -= 25;
  if (subtitle.aiTranslated) score -= 10;
  return score;
}

export function rankCandidates(list: OsSubtitle[]): OsSubtitle[] {
  return [...list].sort((a, b) => quality(b) - quality(a));
}

/**
 * Picks the timing anchor.
 *
 * Hash matches win outright. Among them the caller's preferred anchor languages
 * come first, because a well-made English subtitle is usually the most complete
 * transcript of the dialogue and so the best thing to align against.
 */
export function pickAnchor(
  all: OsSubtitle[],
  anchorLanguages: string[],
  filename: string | undefined,
): Anchor | null {
  const preference = (subtitle: OsSubtitle): number => {
    const index = anchorLanguages.indexOf(subtitle.language);
    return index === -1 ? anchorLanguages.length : index;
  };

  const order = (a: OsSubtitle, b: OsSubtitle): number => {
    const byLanguage = preference(a) - preference(b);
    if (byLanguage !== 0) return byLanguage;
    // Hearing-impaired subtitles add sound cues that are not dialogue, which
    // only blurs the alignment. Prefer a clean transcript when there is one.
    const byHi = Number(a.hearingImpaired) - Number(b.hearingImpaired);
    if (byHi !== 0) return byHi;
    const byTranslation =
      Number(a.machineTranslated || a.aiTranslated) - Number(b.machineTranslated || b.aiTranslated);
    if (byTranslation !== 0) return byTranslation;
    return quality(b) - quality(a);
  };

  const hashed = all.filter((s) => s.moviehashMatch).sort(order);
  if (hashed.length > 0) return { subtitle: hashed[0]!, tier: "hash" };

  if (filename) {
    const scored = all
      .map((subtitle) => ({ subtitle, score: releaseScore(filename, subtitle.release) }))
      .filter((entry) => entry.score >= 0.55)
      .sort((x, y) => y.score - x.score || order(x.subtitle, y.subtitle));
    if (scored.length > 0) return { subtitle: scored[0]!.subtitle, tier: "release" };
  }

  return null;
}
