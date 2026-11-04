import { translationSettings, TranslationError, type TranslationSettings } from "./translation/config";
import { log } from "./log";
import { CREDENTIAL_FIELDS, credentialMode, readProfile, type Profile } from "./credentials/store";

/**
 * Two ways to configure the addon:
 *
 *  - Environment variables, for a private self-hosted instance.
 *  - Per-install user data, which Stremio carries in the addon URL path and
 *    hands back on every request.
 *
 * The administrator selects server keys or mandatory personal profiles.
 * Non-secret user settings override the environment defaults.
 */

export interface RawUserConfig {
  profile?: string;
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
  translation?: TranslationSettings;
  /** Resolved from the server environment or an encrypted personal profile. */
  subdlApiKey?: string;
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

/**
 * Drops fields the user left empty.
 *
 * The SDK's install button sends every field of the form, blank ones as "".
 * Kept, an empty string would win over the environment below and switch off,
 * for example, an API key the instance already has.
 */
function withoutBlanks(raw: RawUserConfig | undefined): RawUserConfig {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (text.trim() === "") continue;
    out[key] = text;
  }
  return out as RawUserConfig;
}

export function resolveConfig(raw: RawUserConfig | undefined): ResolvedConfig {
  const user = withoutBlanks(raw);
  const mode = credentialMode();
  const stored = mode === "user" && user.profile ? readProfile(user.profile) : undefined;
  const settings = { ...stored, ...user };
  const keys: Profile = mode === "server" ? {
    osApiKey: process.env.OS_API_KEY, osUsername: process.env.OS_USERNAME,
    osPassword: process.env.OS_PASSWORD, subdlApiKey: process.env.SUBDL_API_KEY,
    torboxApiKey: process.env.TORBOX_API_KEY,
    aiEnabled: process.env.AI_ENABLED, aiBaseUrl: process.env.AI_BASE_URL,
    aiApiKey: process.env.AI_API_KEY, aiModel: process.env.AI_MODEL,
    aiHeaders: process.env.AI_HEADERS, aiTokenParameter: process.env.AI_TOKEN_PARAMETER,
    aiJsonMode: process.env.AI_JSON_MODE, aiSourceLanguages: process.env.AI_SOURCE_LANGUAGES,
  } : stored ?? {};
  let translation: TranslationSettings | undefined;
  try { translation = translationSettings(keys, mode === "user"); }
  catch (error) {
    log.warn(error instanceof TranslationError ? error.message : "Invalid AI configuration");
  }
  const maxPerLang = Number(settings.maxPerLang ?? process.env.MAX_PER_LANG ?? 5);
  const format = (settings.format ?? process.env.FORMAT ?? "srt").toLowerCase();

  return {
    translation,
    subdlApiKey: keys.subdlApiKey?.trim() || undefined,
    osApiKey: (keys.osApiKey ?? "").trim(),
    osUsername: (keys.osUsername ?? "").trim() || undefined,
    osPassword: (keys.osPassword ?? "") || undefined,
    languages: langList(settings.languages, envList("LANGUAGES", ["en"])),
    anchorLanguages: langList(settings.anchorLanguages, envList("ANCHOR_LANGUAGES", ["en"])),
    maxPerLang: Number.isFinite(maxPerLang) ? Math.min(Math.max(maxPerLang, 1), 20) : 5,
    format: format === "vtt" ? "vtt" : "srt",
    verboseLabels: (settings.labels ?? process.env.LABELS ?? "iso") === "verbose",
    includeUnsynced: isOn(settings.unsynced ?? process.env.INCLUDE_UNSYNCED),
    torboxApiKey: (keys.torboxApiKey ?? "").trim() || undefined,
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
 * Packs non-secret settings and the revocable profile reference into a URL.
 * Legacy raw credential fields are always removed.
 */
export function encodeConfig(raw: RawUserConfig | undefined): string {
  const entries = Object.entries(raw ?? {}).filter(([key, v]) =>
    !CREDENTIAL_FIELDS.includes(key as typeof CREDENTIAL_FIELDS[number]) && v !== undefined && v !== "");
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
