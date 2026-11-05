import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Cue } from "../subtitles/types";
import { toSrt } from "../subtitles/serialize";
import { LANGUAGE, PROMPT_VERSION, TranslationError, type TranslationSettings } from "../translation/config";

export function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
const ID = /^[a-f0-9]{64}$/;
const SCOPE = /^(server|instance|user-[a-f0-9]{64})$/;
const MAX_RECORD = 32 * 1024 * 1024;
const reservations = new Map<string, number>();
const reservedItems = new Map<string, number>();
export interface LibraryContext {
  scope: string;
  timing: string;
  source: { provider: string; fileId: string; language: string };
  videoId?: string;
  release?: string;
  videoHash?: string;
  videoSize?: number;
}
export interface Artifact {
  version: 1;
  id: string;
  sourceHash: string;
  cueCount: number;
  sourceLanguage: string;
  targetLanguage: string;
  profile: Record<string, string | number | boolean>;
  texts: string[];
  checksum: string;
  createdAt: string;
  validation: "structural-only";
}
export interface Variant {
  version: 1;
  id: string;
  artifactId: string;
  textChecksum: string;
  timing: [number, number][];
  provenance: LibraryContext;
  srtChecksum: string;
  createdAt: string;
}
function storageError(message: string): TranslationError { return new TranslationError(message, 503, 30); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function readJson(file: string): unknown {
  if (fs.lstatSync(file).isSymbolicLink()) throw storageError("Symlinked library records are not supported");
  if (fs.statSync(file).size > MAX_RECORD) throw storageError("Translation library record exceeds the size limit");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function syncFile(file: string, body: string): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + ".tmp-" + randomUUID();
  try { syncFile(temporary, JSON.stringify(value)); fs.renameSync(temporary, file); syncDirectory(path.dirname(file)); }
  finally { fs.rmSync(temporary, { force: true }); }
}

/** No authentication secret is part of this content/revision identity. */
export function artifactIdentity(cues: Cue[], source: string, target: string, settings: TranslationSettings): Omit<Artifact, "version" | "texts" | "checksum" | "createdAt" | "validation"> {
  const revision = process.env.AI_PROFILE_REVISION?.trim() || "1";
  if (revision.length > 128 || /[\x00-\x1f]/.test(revision)) throw new TranslationError("Invalid AI profile revision", 400);
  const profile = {
    endpoint: settings.baseUrl, model: settings.model, revision,
    prompt: PROMPT_VERSION, tokenParameter: settings.tokenParameter, maxOutputTokens: settings.maxOutputTokens,
    jsonMode: settings.jsonMode, batchCues: settings.batchCues, batchCharacters: settings.batchCharacters,
  };
  const sourceHash = hash(cues.map((cue) => cue.text));
  const identity = { sourceHash, cueCount: cues.length, sourceLanguage: source, targetLanguage: target, profile };
  return { ...identity, id: hash(identity) };
}

export class TranslationLibrary {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.accessSync(this.root, fs.constants.R_OK | fs.constants.W_OK);
  }
  private artifactDir(scope: string, id: string): string {
    if (!SCOPE.test(scope) || !ID.test(id)) throw storageError("Invalid library reference");
    return path.join(this.root, scope, id);
  }
  private variantDir(scope: string, id: string, variant: string): string {
    if (!ID.test(variant)) throw storageError("Invalid timing variant reference");
    return path.join(this.artifactDir(scope, id), "variants", variant);
  }
  usage(): { bytes: number; items: number } {
    let bytes = 0;
    let items = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw storageError("Symlinks are not supported inside the translation library");
        if (entry.isDirectory()) walk(file);
        else { bytes += fs.statSync(file).size; if (entry.name === "artifact.json") items++; }
      }
    };
    walk(this.root);
    return { bytes, items };
  }
  private capacity(addBytes: number, addItems = 0): void {
    const maxBytes = Number(process.env.TRANSLATION_LIBRARY_MAX_BYTES ?? 1073741824);
    const maxItems = Number(process.env.TRANSLATION_LIBRARY_MAX_ITEMS ?? 10000);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxItems) || maxItems < 1) {
      throw storageError("Invalid translation library capacity settings");
    }
    const usage = this.usage();
    if (usage.bytes + (reservations.get(this.root) ?? 0) + addBytes > maxBytes || usage.items + (reservedItems.get(this.root) ?? 0) + addItems > maxItems) {
      throw new TranslationError("Translation library is full; no saved translations were evicted", 507);
    }
  }
  reserve(cues: Cue[]): () => void {
    const characters = cues.reduce((sum, cue) => sum + cue.text.length, 0);
    // Conservative space for text, escaped JSON, SRT and timing metadata.
    const bytes = (characters * 4 + cues.length * 1024) * 16 + 1048576;
    this.capacity(bytes, 1);
    reservations.set(this.root, (reservations.get(this.root) ?? 0) + bytes);
    reservedItems.set(this.root, (reservedItems.get(this.root) ?? 0) + 1);
    let released = false;
    return () => {
      if (!released) {
        reservations.set(this.root, (reservations.get(this.root) ?? 0) - bytes);
        reservedItems.set(this.root, (reservedItems.get(this.root) ?? 0) - 1);
        released = true;
      }
    };
  }
  load(scope: string, id: string): Artifact | undefined {
    const dir = this.artifactDir(scope, id);
    if (!fs.existsSync(dir)) return undefined;
    try {
      const value = readJson(path.join(dir, "artifact.json"));
      if (!record(value) || value.version !== 1 || value.id !== id || !ID.test(String(value.sourceHash)) ||
          !LANGUAGE.test(String(value.sourceLanguage)) || !LANGUAGE.test(String(value.targetLanguage)) ||
          !record(value.profile) || !Array.isArray(value.texts) || !value.texts.length || value.texts.length > 20000 || value.texts.length !== value.cueCount ||
          value.texts.some((text) => typeof text !== "string" || !text.trim() || text.length > 8192 || text.includes("-->") || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || /\n\s*\n/.test(text)) ||
          value.checksum !== hash(value.texts) ||
          id !== hash({ sourceHash: value.sourceHash, cueCount: value.cueCount, sourceLanguage: value.sourceLanguage, targetLanguage: value.targetLanguage, profile: value.profile }) ||
          value.validation !== "structural-only") throw new Error("invalid");
      return value as unknown as Artifact;
    } catch { throw storageError("Stored translation is corrupt or incomplete; repair or delete it before retrying"); }
  }
  private commitDirectory(destination: string, files: Record<string, string>): void {
    const parent = path.dirname(destination);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = fs.mkdtempSync(path.join(parent, ".tmp-"));
    try {
      for (const [name, body] of Object.entries(files)) syncFile(path.join(temporary, name), body);
      syncDirectory(temporary);
      fs.renameSync(temporary, destination);
      syncDirectory(parent);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  save(scope: string, identity: ReturnType<typeof artifactIdentity>, texts: string[]): Artifact {
    const existing = this.load(scope, identity.id);
    if (existing) return existing;
    if (texts.length !== identity.cueCount || texts.some((text) => !text.trim() || text.length > 8192 || text.includes("-->") || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || /\n\s*\n/.test(text))) {
      throw storageError("Invalid completed translation");
    }
    const artifact: Artifact = { ...identity, version: 1, texts, checksum: hash(texts), createdAt: new Date().toISOString(), validation: "structural-only" };
    const body = JSON.stringify(artifact);
    if (Buffer.byteLength(body) > MAX_RECORD) throw storageError("Translation library record exceeds the size limit");
    this.capacity(Buffer.byteLength(body), 1);
    this.commitDirectory(this.artifactDir(scope, identity.id), { "artifact.json": body });
    return artifact;
  }
  saveVariant(scope: string, artifact: Artifact, cues: Cue[], provenance: LibraryContext): Variant {
    if (cues.length !== artifact.cueCount || cues.some((cue) => !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start)) {
      throw storageError("Invalid timing variant");
    }
    const timing = cues.map((cue): [number, number] => [cue.start, cue.end]);
    const id = hash([artifact.checksum, timing, provenance]);
    const existing = this.variant(scope, artifact.id, id);
    if (existing) return existing.metadata;
    const translated = cues.map((cue, index) => ({ ...cue, text: artifact.texts[index]! }));
    const srt = toSrt(translated);
    const metadata: Variant = { version: 1, id, artifactId: artifact.id, textChecksum: artifact.checksum, timing,
      provenance, srtChecksum: hash(srt), createdAt: new Date().toISOString() };
    const json = JSON.stringify(metadata);
    this.capacity(Buffer.byteLength(srt) + Buffer.byteLength(json));
    this.commitDirectory(this.variantDir(scope, artifact.id, id), { "subtitle.srt": srt, "variant.json": json });
    return metadata;
  }
  variant(scope: string, id: string, variant: string): { metadata: Variant; srt: string } | undefined {
    const dir = this.variantDir(scope, id, variant);
    if (!fs.existsSync(dir)) return undefined;
    try {
      const artifact = this.load(scope, id);
      const value = readJson(path.join(dir, "variant.json"));
      const file = path.join(dir, "subtitle.srt");
      if (fs.statSync(file).size > MAX_RECORD) throw new Error("oversized");
      const srt = fs.readFileSync(file, "utf8");
      if (!artifact || !record(value) || value.version !== 1 || value.id !== variant || value.artifactId !== id ||
          value.textChecksum !== artifact.checksum || value.srtChecksum !== hash(srt) || !Array.isArray(value.timing) ||
          value.timing.length !== artifact.texts.length || !record(value.provenance) ||
          variant !== hash([artifact.checksum, value.timing, value.provenance])) throw new Error("invalid");
      const cues = value.timing.map((pair: unknown, index: number) => {
        if (!Array.isArray(pair) || pair.length !== 2 || !Number.isFinite(pair[0]) || !Number.isFinite(pair[1]) || pair[0] < 0 || pair[1] <= pair[0]) throw new Error("invalid");
        return { start: pair[0] as number, end: pair[1] as number, text: artifact.texts[index]! };
      });
      if (toSrt(cues) !== srt) throw new Error("invalid");
      return { metadata: value as unknown as Variant, srt };
    } catch { throw storageError("Stored timing variant is corrupt or incomplete"); }
  }
  list(): { scope: string; id: string; target: string; variants: string[] }[] {
    const out: { scope: string; id: string; target: string; variants: string[] }[] = [];
    for (const scope of fs.readdirSync(this.root).filter((name) => SCOPE.test(name)).sort()) {
      for (const id of fs.readdirSync(path.join(this.root, scope)).filter((name) => ID.test(name)).sort()) {
        const artifact = this.load(scope, id)!;
        const variants = path.join(this.artifactDir(scope, id), "variants");
        out.push({ scope, id, target: artifact.targetLanguage, variants: fs.existsSync(variants) ? fs.readdirSync(variants).filter((name) => ID.test(name)).sort() : [] });
      }
    }
    return out;
  }
  export(scope: string, id: string, variant: string, destination: string): void {
    const artifact = this.load(scope, id);
    const selected = this.variant(scope, id, variant);
    if (!artifact || !selected) throw storageError("Translation export reference was not found");
    if (fs.existsSync(destination)) throw storageError("Export destination must not already exist");
    this.commitDirectory(path.resolve(destination), { "subtitle.srt": selected.srt, "provenance.json": JSON.stringify({ artifact, variant: selected.metadata }, null, 2) });
  }
  delete(scope: string, id: string): void { fs.rmSync(this.artifactDir(scope, id), { recursive: true, force: true }); }
  writePublication(id: string, value: unknown): void {
    if (!ID.test(id)) throw storageError("Invalid publication reference");
    const file = path.join(this.root, "outbox", id + ".json");
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > 65536) throw storageError("Publication metadata is too large");
    this.capacity(Math.max(0, bytes - (fs.existsSync(file) ? fs.statSync(file).size : 0)));
    atomicJson(file, value);
  }
  backup(destination: string): void {
    if (fs.existsSync(destination) || path.resolve(destination).startsWith(this.root + path.sep)) throw storageError("Backup destination must be new and outside the library");
    const entries = this.list();
    for (const entry of entries) for (const variant of entry.variants) this.variant(entry.scope, entry.id, variant);
    fs.cpSync(this.root, destination, { recursive: true, filter: (file) => !path.relative(this.root, file).split(path.sep).some((part) => part.includes(".tmp-") || part.endsWith(".lock")) });
    atomicJson(path.join(destination, "backup.json"), { format: "subtitle-sync-library", version: 1, entries, createdAt: new Date().toISOString() });
  }
}

export function openLibrary(): TranslationLibrary | undefined {
  const root = process.env.TRANSLATION_LIBRARY_DIR?.trim();
  if (!root) return undefined;
  try { return new TranslationLibrary(root); }
  catch { throw storageError("Translation library is unavailable; check the persistent volume"); }
}
