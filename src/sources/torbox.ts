import { TtlCache } from "../cache";
import { log } from "../log";
import { rankCandidates, type CandidateFile } from "./match";
import type { FileHint, ResolvedFile, StreamSource } from "./types";

/**
 * TorBox as a stream source.
 *
 * Two calls: list what the account holds, then ask for a download link for one
 * file. Note that the two use different authentication. Listing takes a bearer
 * header; the download link endpoint takes the key as a query parameter and
 * rejects the header. That asymmetry is in TorBox's API, not a mistake here.
 */

const API = (process.env.TORBOX_API_BASE ?? "https://api.torbox.app/v1/api").replace(/\/+$/, "");
const TIMEOUT_MS = 30_000;
const PAGE_SIZE = 1000;

/** The account listing changes rarely and is large, so it is worth holding. */
const listCache = new TtlCache<CandidateFile[]>(10 * 60_000, 4);
/** Download links are valid for about three hours; refresh well inside that. */
const linkCache = new TtlCache<string>(60 * 60_000, 200);

/** The three kinds of item a TorBox account can hold, each with its own routes. */
const KINDS = ["torrents", "usenet", "webdl"] as const;
type Kind = (typeof KINDS)[number];

/** Each kind names its id parameter differently on the download endpoint. */
const ID_PARAM: Record<Kind, string> = {
  torrents: "torrent_id",
  usenet: "usenet_id",
  webdl: "web_id",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class TorBoxSource implements StreamSource {
  readonly name = "torbox";

  constructor(private readonly apiKey: string) {}

  private async getJson(path: string): Promise<unknown> {
    const response = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`TorBox ${path} returned ${response.status}`);
    }
    return response.json();
  }

  /** Everything in the account, flattened to individual files. */
  private async listFiles(): Promise<CandidateFile[]> {
    return listCache.wrap(`list:${this.apiKey.slice(-8)}`, async () => {
      const all: CandidateFile[] = [];

      for (const kind of KINDS) {
        try {
          // One page is enough for any normal account; a second is cheap insurance.
          for (let offset = 0; offset < PAGE_SIZE * 2; offset += PAGE_SIZE) {
            const body = await this.getJson(
              `/${kind}/mylist?limit=${PAGE_SIZE}&offset=${offset}`,
            );
            const items = isRecord(body) && Array.isArray(body["data"]) ? body["data"] : [];
            if (items.length === 0) break;
            for (const item of items) all.push(...flattenItem(item, kind));
            if (items.length < PAGE_SIZE) break;
          }
        } catch (error) {
          // One empty or unavailable list must not hide the other two.
          log.debug(`TorBox ${kind} list unavailable: ${describe(error)}`);
        }
      }

      log.debug(`TorBox account holds ${all.length} files`);
      return all;
    });
  }

  private async downloadLink(file: CandidateFile): Promise<string | null> {
    const key = `${file.kind}:${file.containerId}:${file.fileId}`;
    try {
      return await linkCache.wrap(key, async () => {
        const params = new URLSearchParams({
          token: this.apiKey,
          [ID_PARAM[file.kind as Kind]]: String(file.containerId),
          file_id: String(file.fileId),
        });
        const response = await fetch(`${API}/${file.kind}/requestdl?${params.toString()}`, {
          headers: { Accept: "application/json" },
          redirect: "follow",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`requestdl returned ${response.status}`);
        }

        const body: unknown = await response.json();
        const link = isRecord(body) ? body["data"] : undefined;
        if (typeof link !== "string" || link === "") {
          throw new Error("requestdl returned no link");
        }
        return link;
      });
    } catch (error) {
      log.warn(`TorBox download link failed for ${file.name}: ${describe(error)}`);
      return null;
    }
  }

  async resolve(hint: FileHint): Promise<ResolvedFile[]> {
    const files = await this.listFiles();
    const ranked = rankCandidates(files, hint).slice(0, 3);
    if (ranked.length === 0) {
      log.info("TorBox has no file matching this video");
      return [];
    }

    const resolved: ResolvedFile[] = [];
    for (const file of ranked) {
      const url = await this.downloadLink(file);
      if (url) {
        resolved.push({
          url,
          name: file.name,
          size: file.size,
          source: this.name,
          verified: hint.videoHash !== undefined && file.hash === hint.videoHash,
        });
      }
    }
    return resolved;
  }
}

function flattenItem(item: unknown, kind: Kind): CandidateFile[] {
  if (!isRecord(item)) return [];
  const containerId = num(item["id"]);
  if (containerId === 0) return [];

  const files = Array.isArray(item["files"]) ? item["files"] : [];
  const out: CandidateFile[] = [];
  for (const entry of files) {
    if (!isRecord(entry)) continue;
    const name = String(entry["short_name"] ?? entry["name"] ?? "");
    const size = num(entry["size"]);
    if (name === "" || size === 0) continue;

    // TorBox stores the OpenSubtitles hash alongside each file, which is the
    // same value Stremio sends us. When it is there, matching is exact.
    const stored = entry["opensubtitles_hash"];
    const hash = typeof stored === "string" && stored !== "" ? stored.toLowerCase() : undefined;

    out.push({ containerId, fileId: num(entry["id"]), name, size, kind, hash });
  }
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
