export class TranslationError extends Error {
  constructor(message: string, readonly status = 502, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "TranslationError";
  }
}

export interface TranslationSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  sourceLanguages: string[];
  tokenParameter: "max_tokens" | "max_completion_tokens";
  jsonMode: boolean;
  maxOutputTokens: number;
  batchCues: number;
  batchCharacters: number;
  maxCues: number;
  maxCharacters: number;
  requestTimeoutMs: number;
  jobTimeoutMs: number;
  responseWaitMs: number;
  hourlyCalls: number;
  concurrency: number;
}
export type TranslationInput = Partial<Record<"aiEnabled" | "aiBaseUrl" | "aiApiKey" | "aiModel" | "aiHeaders" | "aiTokenParameter" | "aiJsonMode" | "aiSourceLanguages", string>>;
export const LANGUAGE = /^[a-z]{2,3}(?:-[a-z]{2})?$/;
export const PROMPT_VERSION = "subtitle-json-v1";

function limit(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new TranslationError(`Invalid ${name} limit`, 400);
  return value;
}
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TranslationError("Invalid AI base URL", 400); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.pathname.replace(/\/+$/, "").endsWith("/chat/completions")) {
    throw new TranslationError("Use an AI base URL without credentials, query or /chat/completions", 400);
  }
  if (url.protocol === "http:" && process.env.AI_ALLOW_HTTP !== "true") {
    throw new TranslationError("HTTP AI endpoints require explicit administrator permission", 400);
  }
  return url.toString().replace(/\/+$/, "");
}
function extraHeaders(value: string): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value || "{}"); } catch { throw new TranslationError("Invalid AI headers JSON", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 8) {
    throw new TranslationError("Invalid AI headers", 400);
  }
  const headers: Record<string, string> = {};
  for (const [name, text] of Object.entries(parsed)) {
    const lower = name.toLowerCase();
    if ((!/^x-[a-z0-9-]+$/.test(lower) && !["http-referer", "api-key"].includes(lower)) ||
        /^x-(forwarded|real-ip|http-method)/.test(lower) || typeof text !== "string" || text.length > 2048 || /[\r\n\x00]/.test(text)) {
      throw new TranslationError("Unsupported or invalid AI header", 400);
    }
    headers[lower] = text;
  }
  return headers;
}

/** Personal endpoints require an exact administrator allowlist; no DNS probing. */
export function translationSettings(input: TranslationInput, personal: boolean): TranslationSettings | undefined {
  if (!["true", "1", "on", "yes"].includes(input.aiEnabled?.toLowerCase() ?? "")) return undefined;
  const baseUrl = normalizeBaseUrl(input.aiBaseUrl ?? "");
  if (personal) {
    const allowed = (process.env.AI_ALLOWED_BASE_URLS ?? "").split(",").filter(Boolean).map((url) => normalizeBaseUrl(url.trim()));
    if (!allowed.includes(baseUrl)) throw new TranslationError("AI endpoint is not allowed by the administrator", 400);
  }
  const model = input.aiModel?.trim() ?? "";
  const apiKey = input.aiApiKey?.trim() ?? "";
  if (!model || model.length > 200 || /[\x00-\x1f]/.test(model) || apiKey.length > 8192 || /[\r\n\x00]/.test(apiKey)) {
    throw new TranslationError("Invalid AI model or API key", 400);
  }
  const tokenParameter = input.aiTokenParameter || process.env.AI_TOKEN_PARAMETER || "max_tokens";
  if (tokenParameter !== "max_tokens" && tokenParameter !== "max_completion_tokens") throw new TranslationError("Invalid AI token parameter", 400);
  const jsonMode = input.aiJsonMode || process.env.AI_JSON_MODE || "off";
  if (!["off", "object"].includes(jsonMode)) throw new TranslationError("Invalid AI JSON mode", 400);
  const sourceLanguages = [...new Set((input.aiSourceLanguages || process.env.AI_SOURCE_LANGUAGES || "en").split(",").map((code) => code.trim().toLowerCase()))];
  if (!sourceLanguages.length || sourceLanguages.length > 5 || sourceLanguages.some((code) => !LANGUAGE.test(code))) {
    throw new TranslationError("Invalid AI source languages", 400);
  }
  return {
    baseUrl, apiKey, model, headers: extraHeaders(input.aiHeaders ?? ""), sourceLanguages,
    tokenParameter, jsonMode: jsonMode === "object",
    maxOutputTokens: limit("AI_MAX_OUTPUT_TOKENS", 4096, 256, 16384),
    batchCues: limit("AI_BATCH_CUES", 32, 1, 64),
    batchCharacters: limit("AI_BATCH_CHARACTERS", 6000, 128, 12000),
    maxCues: limit("AI_MAX_CUES", 5000, 1, 20000),
    maxCharacters: limit("AI_MAX_CHARACTERS", 500000, 1, 1000000),
    requestTimeoutMs: limit("AI_REQUEST_TIMEOUT_MS", 30000, 10, 120000),
    jobTimeoutMs: limit("AI_JOB_TIMEOUT_MS", 180000, 10, 600000),
    responseWaitMs: limit("AI_RESPONSE_WAIT_MS", 5000, 1, 8000),
    hourlyCalls: limit("AI_HOURLY_CALLS", 120, 1, 1000),
    concurrency: limit("AI_CONCURRENCY", 2, 1, 4),
  };
}
