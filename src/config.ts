/**
 * Two ways to configure the addon:
 *
 *  - Environment variables, for a private self-hosted instance.
 *  - Per-install user data, which Stremio carries in the addon URL path and
 *    hands back on every request.
 *
 * User data wins where present; the environment fills the rest.
 */

export interface RawUserConfig {
  osApiKey?: string;
  osUsername?: string;
  osPassword?: string;
  languages?: string;
  anchorLanguages?: string;
  maxPerLang?: string;
  format?: string;
  labels?: string;
  unsynced?: string;
  torboxApiKey?: string;
}

export interface ResolvedConfig {
  osApiKey: string;
  osUsername: string | undefined;
  osPassword: string | undefined;
  languages: string[];
  anchorLanguages: string[];
  maxPerLang: number;
  format: "srt" | "vtt";
  /**
   * Off by default. Stremio groups subtitles by the `lang` field, and only a
   * plain ISO 639-2 code lands in its own language entry ("English", "Polski")
   * beside other addons' subtitles. A verbose label makes an entry of its own.
   */
  verboseLabels: boolean;
  /**
   * Whether to offer subtitles that could not be aligned to anything. Off by
   * default: other addons already serve subtitles as uploaded, so an entry this
   * addon cannot improve is just noise in the player's menu.
   */
  includeUnsynced: boolean;
  /**
   * TorBox API key. With it, the addon can find the video file again and read a
   * timing reference straight out of it when OpenSubtitles has never seen the
   * file. Without it, only the OpenSubtitles anchor is available.
   */
  torboxApiKey: string | undefined;
  /** How many stretches of the file to sample. */
  embeddedWindows: number;
  /** How long each stretch is. Traffic is roughly windows x seconds x bitrate. */
  embeddedWindowSeconds: number;
}

/** Placeholder used in URLs when the install carries no user data of its own. */
export const EMPTY_CONFIG_TOKEN = "_";

function langList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const parsed = value
    .split(/[,\s]+/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function envList(name: string, fallback: string[]): string[] {
  return langList(process.env[name], fallback);
}

export function resolveConfig(raw: RawUserConfig | undefined): ResolvedConfig {
  const user = raw ?? {};
  const maxPerLang = Number(user.maxPerLang ?? process.env.MAX_PER_LANG ?? 5);
  const format = (user.format ?? process.env.FORMAT ?? "srt").toLowerCase();

  return {
    osApiKey: (user.osApiKey ?? process.env.OS_API_KEY ?? "").trim(),
    osUsername: (user.osUsername ?? process.env.OS_USERNAME ?? "").trim() || undefined,
    osPassword: (user.osPassword ?? process.env.OS_PASSWORD ?? "") || undefined,
    languages: langList(user.languages, envList("LANGUAGES", ["en"])),
    anchorLanguages: langList(user.anchorLanguages, envList("ANCHOR_LANGUAGES", ["en"])),
    maxPerLang: Number.isFinite(maxPerLang) ? Math.min(Math.max(maxPerLang, 1), 20) : 5,
    format: format === "vtt" ? "vtt" : "srt",
    verboseLabels: (user.labels ?? process.env.LABELS ?? "iso") === "verbose",
    includeUnsynced: isOn(user.unsynced ?? process.env.INCLUDE_UNSYNCED),
    torboxApiKey: (user.torboxApiKey ?? process.env.TORBOX_API_KEY ?? "").trim() || undefined,
    embeddedWindows: bounded(process.env.EMBEDDED_WINDOWS, 6, 1, 20),
    embeddedWindowSeconds: bounded(process.env.EMBEDDED_WINDOW_SECONDS, 20, 5, 300),
  };
}

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

/** The SDK posts a ticked checkbox as "on"; the environment uses "true"/"1". */
function isOn(value: string | undefined): boolean {
  if (!value) return false;
  return ["on", "true", "1", "yes", "checked"].includes(value.trim().toLowerCase());
}

/**
 * Packs the user's own settings back into a URL segment.
 *
 * Only what the user actually supplied goes in, so a self-hosted instance that
 * gets everything from the environment never puts its API key in a URL.
 */
export function encodeConfig(raw: RawUserConfig | undefined): string {
  const entries = Object.entries(raw ?? {}).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return EMPTY_CONFIG_TOKEN;
  const json = JSON.stringify(Object.fromEntries(entries));
  return Buffer.from(json, "utf8").toString("base64url");
}

export function decodeConfig(token: string | undefined): RawUserConfig | undefined {
  if (!token || token === EMPTY_CONFIG_TOKEN) return undefined;
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RawUserConfig;
    }
  } catch {
    // A malformed token is treated as no user data, not as an error: the
    // environment defaults may well be enough to answer the request.
  }
  return undefined;
}
