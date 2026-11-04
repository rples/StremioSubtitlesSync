import { createHash } from "node:crypto";
import { TtlCache } from "../cache";
import { decodeSubtitle } from "../opensubtitles/client";
import type { SearchQuery } from "../opensubtitles/types";
import type { SubtitleCandidate } from "../providers/types";
import { parseSubtitle } from "../subtitles/parse";
import { subdlLanguage } from "./languages";
import { SUBDL_ID, validSubdlFileId } from "./reference";

const API = "https://api.subdl.com/api/v2";
const DOWNLOAD = "https://dl.subdl.com";
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 3;
const ID = SUBDL_ID;
const searchCache = new TtlCache<SubtitleCandidate[]>(15 * 60_000, 300);
const fileCache = new TtlCache<string>(12 * 60 * 60_000, 300);
const backoff = new TtlCache<boolean>(60_000, 100);

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function retryAfter(value: string | null): number {
  if (!value) return 60;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds;
  return Math.ceil((Date.parse(value) - Date.now()) / 1000) || 60;
}

export class SubdlError extends Error {
  constructor(message: string, readonly status = 502, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "SubdlError";
  }
}

/** Only take IDs from the documented origin/path. Never retain queries or URLs. */
function unpackedId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value, DOWNLOAD);
    if (url.origin !== DOWNLOAD || url.username || url.password || url.hash) return undefined;
    const parts = /^\/subtitle\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    return parts ? `${parts[1]}~${parts[2]}` : undefined;
  } catch {
    return undefined;
  }
}

/** Exposed options let tests use an in-process transport, never provider accounts. */
interface Options {
  apiKey: string;
  fetch?: typeof fetch;
}

export class SubdlClient {
  private readonly scope: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: Options) {
    if (!options.apiKey) throw new SubdlError("No SubDL API key configured", 400);
    this.scope = createHash("sha256").update(options.apiKey).digest("hex");
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private async request(url: string, limit: number, download = false): Promise<Buffer> {
    if (backoff.get(this.scope)) throw new SubdlError("SubDL account is cooling down", 429, 60);
    try {
      const response = await this.fetch(url, {
        headers: download
          ? { "X-API-Key": this.options.apiKey }
          : { Authorization: `Bearer ${this.options.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403, 406, 429].includes(response.status)) {
          const seconds = Math.min(3600, Math.max(60, retryAfter(response.headers.get("Retry-After"))));
          backoff.set(this.scope, true, seconds * 1000);
          throw new SubdlError(`SubDL returned HTTP ${response.status}`, response.status, seconds);
        }
        throw new SubdlError(`SubDL returned HTTP ${response.status}`, response.status);
      }
      if (Number(response.headers.get("Content-Length")) > limit) {
        await response.body?.cancel();
        throw new SubdlError("SubDL response exceeds the size limit");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new SubdlError("SubDL returned an empty response");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > limit) throw new SubdlError("SubDL response exceeds the size limit");
          chunks.push(next.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof SubdlError) throw error;
      // Fetch errors/redirect errors may embed the URL or request headers.
      throw new SubdlError("SubDL request failed or timed out");
    }
  }

  async search(query: SearchQuery): Promise<SubtitleCandidate[]> {
    const key = `${this.scope}:${JSON.stringify({ ...query, moviehash: undefined, languages: [...query.languages].sort() })}`;
    return searchCache.wrap(key, async () => {
      const found = new Map<string, SubtitleCandidate>();
      for (let page = 1; page <= MAX_PAGES; page++) {
        const params = new URLSearchParams({
          imdb_id: `tt${String(query.imdbId).padStart(7, "0")}`,
          type: query.type === "movie" ? "movie" : "tv",
          languages: query.languages.join(","), unpack: "1", subs_per_page: "30", page: String(page),
        });
        if (query.type === "episode") {
          params.set("season", String(query.season));
          params.set("episode", String(query.episode));
        }
        const bytes = await this.request(`${API}/subtitles/search?${params}`, MAX_SEARCH_BYTES);
        let body: unknown;
        try { body = JSON.parse(bytes.toString("utf8")); } catch { throw new SubdlError("SubDL returned invalid JSON"); }
        if (record(body) && body.status === false) {
          backoff.set(this.scope, true);
          throw new SubdlError("SubDL rejected the search request", 503, 60);
        }
        if (!record(body) || body.status !== true || !Array.isArray(body.subtitles)) {
          throw new SubdlError("SubDL returned an invalid search response");
        }
        if (body.subtitles.length === 0) break;
        // Legacy-shaped v2 responses associate subtitles with the first result.
        if (!Array.isArray(body.results) || !record(body.results[0]) ||
            String(body.results[0].imdb_id).replace(/^tt/, "").replace(/^0+/, "") !== String(query.imdbId) ||
            body.results[0].type !== (query.type === "movie" ? "movie" : "tv")) {
          throw new SubdlError("SubDL search returned a different title");
        }
        for (const item of body.subtitles.slice(0, 100)) {
          if (!record(item)) continue;
          for (const candidate of candidates(item, query)) found.set(String(candidate.fileId), candidate);
        }
        const totalPages = Number(body.totalPages ?? 1);
        if (!Number.isSafeInteger(totalPages) || page >= totalPages) break;
      }
      return [...found.values()];
    });
  }

  async fetchFile(fileId: string, language: string): Promise<string> {
    if (!validSubdlFileId(fileId)) throw new SubdlError("Bad SubDL file reference", 400);
    return fileCache.wrap(`${this.scope}:${fileId}:${language}`, async () => {
      const [parent, child] = fileId.split("~");
      const url = child
        ? `${DOWNLOAD}/subtitle/${parent}/${child}`
        : `${API}/subtitles/${parent}/download?format=file`;
      const bytes = await this.request(url, MAX_FILE_BYTES, !!child);
      if (bytes.subarray(0, 2).toString() === "PK" || bytes.includes(0)) {
        throw new SubdlError("SubDL did not return a single text subtitle");
      }
      const text = decodeSubtitle(bytes, language);
      const cues = parseSubtitle(text);
      if (cues.length === 0 || cues.length > 20_000 ||
          cues.some((cue) => cue.start < 0 || cue.end <= cue.start || !cue.text)) {
        throw new SubdlError("SubDL returned an invalid text subtitle");
      }
      return text;
    });
  }
}

function candidates(item: RecordValue, query: SearchQuery): SubtitleCandidate[] {
  const children = Array.isArray(item.unpack_files) ? item.unpack_files.slice(0, 100) : [];
  if (children.length) {
    return children.filter(record).flatMap((file) => {
      const id = unpackedId(file.url);
      if (!id || !["srt", "vtt", "ass", "ssa"].includes(String(file.format).toLowerCase())) return [];
      return candidate(item, file, id, query);
    });
  }
  // Never ask the single-file endpoint to choose a file from a season pack.
  if (item.full_season || !ID.test(String(item.n_id ?? item.nId ?? ""))) return [];
  return candidate(item, item, String(item.n_id ?? item.nId), query);
}

function candidate(parent: RecordValue, file: RecordValue, id: string, query: SearchQuery): SubtitleCandidate[] {
  if (query.type === "episode" &&
      (Number(file.season) !== query.season || Number(file.episode) !== query.episode ||
       (file === parent && ((parent.episode_from != null && Number(parent.episode_from) !== query.episode) ||
                            (parent.episode_end != null && Number(parent.episode_end) !== query.episode))))) return [];
  const language = subdlLanguage(file.lang ?? file.language ?? parent.lang ?? parent.language);
  if (!language || !query.languages.includes(language)) return [];
  const fps = Number(parent.fps);
  return [{
    provider: "subdl", subtitleId: id, fileId: id,
    fileName: String(file.name ?? parent.name ?? ""), language,
    release: String(file.release_name ?? parent.release_name ?? ""),
    downloadCount: 0, ratings: 0, fps: Number.isFinite(fps) && fps > 0 ? fps : null,
    hearingImpaired: file.hi === true || file.hi === 1 || parent.hi === true || parent.hi === 1,
    aiTranslated: parent.ai_translated === true, machineTranslated: parent.machine_translated === true,
    fromTrusted: false, moviehashMatch: false,
  }];
}
