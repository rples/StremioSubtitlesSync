import { createHash } from "node:crypto";
import type { ResolvedConfig } from "../config";
import { log } from "../log";
import { OpenSubtitlesClient } from "../opensubtitles/client";
import type { OsSubtitle, SearchQuery } from "../opensubtitles/types";
import { OpenSubtitlesError } from "../opensubtitles/types";
import { SubdlClient } from "../subdl/client";
import type { FileRef } from "../urls";
import type { SubtitleCandidate } from "./types";

function openSubtitles(config: ResolvedConfig): OpenSubtitlesClient {
  return new OpenSubtitlesClient({ apiKey: config.osApiKey, username: config.osUsername, password: config.osPassword });
}

/** One provider failing must not discard the other provider's candidates. */
export async function searchProviders(config: ResolvedConfig, query: SearchQuery): Promise<{
  candidates: SubtitleCandidate[];
  anchors: OsSubtitle[];
}> {
  const [os, sd] = await Promise.allSettled([
    config.osApiKey ? openSubtitles(config).search(query) : Promise.resolve([]),
    config.subdlApiKey ? new SubdlClient({ apiKey: config.subdlApiKey }).search(query) : Promise.resolve([]),
  ] as const);
  if (os.status === "rejected") log.warn("OpenSubtitles search unavailable");
  if (sd.status === "rejected") log.warn("SubDL search unavailable");
  const anchors = os.status === "fulfilled" ? os.value : [];
  const extra = sd.status === "fulfilled" ? sd.value : [];
  return { anchors, candidates: [...anchors, ...extra] };
}

export async function fetchSubtitle(config: ResolvedConfig, ref: FileRef): Promise<string> {
  if (ref.provider === "subdl") {
    return new SubdlClient({ apiKey: config.subdlApiKey ?? "" }).fetchFile(String(ref.fileId), ref.lang);
  }
  if (typeof ref.fileId !== "number" || !config.osApiKey) {
    throw new OpenSubtitlesError("No OpenSubtitles API key or invalid file reference", 400);
  }
  return openSubtitles(config).fetchFile(ref.fileId, ref.lang);
}

/** Output cache must not mix provider IDs or account credentials. */
export function providerCacheScope(config: ResolvedConfig): string {
  return createHash("sha256").update(JSON.stringify([
    config.osApiKey, config.osUsername, config.osPassword, config.subdlApiKey,
  ])).digest("hex");
}
