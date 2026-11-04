import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CREDENTIAL_FIELDS = ["osApiKey", "osUsername", "osPassword", "subdlApiKey", "torboxApiKey",
  "aiEnabled", "aiBaseUrl", "aiApiKey", "aiModel", "aiHeaders", "aiTokenParameter", "aiJsonMode", "aiSourceLanguages"] as const;
export const SETTING_FIELDS = ["languages", "anchorLanguages", "maxPerLang", "format", "labels", "unsynced"] as const;
export type Profile = Partial<Record<typeof CREDENTIAL_FIELDS[number] | typeof SETTING_FIELDS[number], string>>;
const TOKEN = /^p_[A-Za-z0-9_-]{43}$/;

/** Two policies only. A typo must never silently expose the server's keys. */
export function credentialMode(): "server" | "user" {
  const mode = process.env.CREDENTIAL_MODE ?? "server";
  if (mode !== "server" && mode !== "user") throw new Error("CREDENTIAL_MODE must be server or user");
  return mode;
}

function encryptionKey(): Buffer {
  const secretFile = process.env.PROFILE_ENCRYPTION_KEY_FILE;
  const value = secretFile ? fs.readFileSync(secretFile, "utf8").trim() : process.env.PROFILE_ENCRYPTION_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("A persistent 32-byte hex profile encryption key is required");
  return Buffer.from(value, "hex");
}

function directory(): string {
  return path.resolve(process.env.PROFILE_DIR ?? "data/profiles");
}

function fileName(token: string): string | undefined {
  if (!TOKEN.test(token)) return undefined;
  return path.join(directory(), createHash("sha256").update(token).digest("hex") + ".json");
}

export function validateProfileStore(): void {
  encryptionKey();
  fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
  fs.accessSync(directory(), fs.constants.R_OK | fs.constants.W_OK);
}

/** Store only known string fields. Future providers must opt in explicitly. */
export function parseProfile(value: unknown): Profile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a configuration object");
  const fields = [...CREDENTIAL_FIELDS, ...SETTING_FIELDS];
  const out: Profile = {};
  for (const [key, text] of Object.entries(value)) {
    if (!fields.includes(key as typeof fields[number]) || typeof text !== "string" || text.length > 8192) {
      throw new Error("Unknown or invalid configuration field");
    }
    if (text.trim()) out[key as keyof Profile] = key === "osPassword" ? text : text.trim();
  }
  if (!out.osApiKey && !out.subdlApiKey) throw new Error("Supply your own OpenSubtitles or SubDL API key");
  return out;
}

export function createProfile(profile: Profile): string {
  validateProfileStore();
  if (fs.readdirSync(directory()).filter((name) => name.endsWith(".json")).length >= 1000) {
    throw new Error("Profile capacity reached; contact the administrator");
  }
  const token = "p_" + randomBytes(32).toString("base64url");
  const destination = fileName(token)!;
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(path.basename(destination)));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(profile), "utf8"), cipher.final()]);
  const body = JSON.stringify({ version: 1, nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") });
  const temporary = destination + ".tmp";
  try {
    fs.writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return token;
}

export function readProfile(token: string): Profile | undefined {
  const file = fileName(token);
  if (!file) return undefined;
  try {
    if (fs.statSync(file).size > 64 * 1024) return undefined;
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    if (body.version !== 1) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(body.nonce, "base64"));
    decipher.setAAD(Buffer.from(path.basename(file)));
    decipher.setAuthTag(Buffer.from(body.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(body.data, "base64")), decipher.final()]);
    return parseProfile(JSON.parse(plaintext.toString("utf8")));
  } catch {
    // Missing, revoked, tampered or unreadable profiles never select host keys.
    return undefined;
  }
}

export function revokeProfile(token: string): void {
  const file = fileName(token);
  if (file) fs.rmSync(file, { force: true });
}
