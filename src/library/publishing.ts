import fs from "node:fs";
import path from "node:path";
import { TranslationError } from "../translation/config";
import { hash, TranslationLibrary } from "./store";

const ID = /^[a-f0-9]{64}$/;
const REMOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export interface PublishMetadata {
  type: "movie" | "tv";
  tmdbId: number;
  imdbId: string;
  name: string;
  releases: string[];
  quality: "web" | "bluray" | "dvd" | "hdtv" | "cam";
  framerate: number;
  season: number;
  episode: number;
  hearingImpaired: boolean;
  credits: string;
  reviewNote: string;
  rightsConfirmed: true;
  qualityReviewed: true;
  accountOwnerConsent: true;
}
export type PublicationState = "draft" | "approved" | "uploading" | "submitted" | "rejected" | "uncertain" | "published-manual" | "moderation-rejected" | "cancelled";
export interface Publication {
  version: 1;
  id: string;
  scope: string;
  artifactId: string;
  variantId: string;
  metadata: PublishMetadata;
  state: PublicationState;
  attempts: number;
  reviewHash?: string;
  nId?: string;
  fileId?: string;
  publicUrl?: string;
  lastError?: string;
  moderationNote?: string;
  updatedAt: string;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function error(message: string): TranslationError { return new TranslationError(message, 400); }
export function publicationMetadata(value: unknown): PublishMetadata {
  if (!record(value)) throw error("Publication metadata must be an object");
  const allowed = ["type", "tmdbId", "imdbId", "name", "releases", "quality", "framerate", "season", "episode", "hearingImpaired", "credits", "reviewNote", "rightsConfirmed", "qualityReviewed", "accountOwnerConsent"];
  if (Object.keys(value).some((key) => !allowed.includes(key)) ||
      !["movie", "tv"].includes(String(value.type)) || !Number.isSafeInteger(value.tmdbId) || Number(value.tmdbId) < 1 ||
      typeof value.imdbId !== "string" || !/^tt\d{7,12}$/.test(value.imdbId) ||
      !["web", "bluray", "dvd", "hdtv", "cam"].includes(String(value.quality)) ||
      ![0, 2, 6, 5, 3, 4, 7].includes(Number(value.framerate)) || typeof value.framerate !== "number" ||
      !Number.isSafeInteger(value.season) || Number(value.season) < 0 || Number(value.season) > 999 ||
      !Number.isSafeInteger(value.episode) || Number(value.episode) < 0 || Number(value.episode) > 9999 ||
      (value.type === "movie" && (value.season !== 0 || value.episode !== 0)) || (value.type === "tv" && Number(value.episode) < 1) ||
      typeof value.hearingImpaired !== "boolean" || value.rightsConfirmed !== true || value.qualityReviewed !== true || value.accountOwnerConsent !== true) {
    throw error("Publication requires valid movie/episode metadata, rights, quality review and account-owner consent");
  }
  for (const name of ["name", "credits", "reviewNote"]) {
    if (typeof value[name] !== "string" || !value[name].trim() || value[name].length > 1000 || /[\x00-\x1f]/.test(value[name])) throw error("Invalid publication name, attribution or review note");
  }
  if (!Array.isArray(value.releases) || !value.releases.length || value.releases.length > 10 ||
      value.releases.some((release) => typeof release !== "string" || !release.trim() || release.length > 300 || /[\x00-\x1f]/.test(release))) throw error("Explicit compatible release names are required");
  return { ...value, releases: [...new Set(value.releases)].sort() } as unknown as PublishMetadata;
}

/** No read/download key is accepted as an implicit upload credential. */
export function uploadCredentials(): { token: string; mode: "raw" | "bearer-final" } {
  if (process.env.SUBDL_PUBLISHING_ENABLED !== "true") throw error("SubDL publishing is disabled");
  const file = process.env.SUBDL_UPLOAD_TOKEN_FILE;
  let token: string;
  try { token = (file ? fs.readFileSync(file, "utf8") : process.env.SUBDL_UPLOAD_TOKEN ?? "").trim(); }
  catch { throw error("Upload credential is unavailable"); }
  const mode = process.env.SUBDL_UPLOAD_HEADER_MODE;
  if (!token || token.length > 8192 || /[\r\n\x00]/.test(token) || (mode !== "raw" && mode !== "bearer-final")) {
    throw error("Configure a separate upload token and an explicitly verified raw or bearer-final header mode");
  }
  return { token, mode };
}

class RejectedSubmission extends Error {}
async function uploadJson(route: string, token: string, form: FormData | undefined, transport: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await transport(`https://api3.subdl.com/user/${route}`, {
      method: form ? "POST" : "GET", headers: { token }, body: form,
      redirect: "error", signal: AbortSignal.timeout(20000),
    });
  } catch { throw new Error("Remote outcome is uncertain"); }
  if (!response.ok) { await response.body?.cancel(); throw new Error("Remote outcome is uncertain"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Remote outcome is uncertain");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 65536) throw new Error("oversized");
      chunks.push(next.value);
    }
  } catch { await reader.cancel().catch(() => undefined); throw new Error("Remote outcome is uncertain"); }
  finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Remote outcome is uncertain"); }
  if (!record(value)) throw new Error("Remote outcome is uncertain");
  if (value.ok === false || value.status === false) throw new RejectedSubmission("SubDL rejected the submission");
  return value;
}

export class PublicationQueue {
  private readonly directory: string;
  constructor(private readonly library: TranslationLibrary) { this.directory = path.join(library.root, "outbox"); }
  private file(id: string): string {
    if (!ID.test(id)) throw error("Invalid publication reference");
    return path.join(this.directory, id + ".json");
  }
  load(id: string): Publication {
    try {
      const file = this.file(id);
      if (fs.statSync(file).size > 65536) throw new Error("oversized");
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      const states: PublicationState[] = ["draft", "approved", "uploading", "submitted", "rejected", "uncertain", "published-manual", "moderation-rejected", "cancelled"];
      if (!record(value) || value.version !== 1 || value.id !== id || !states.includes(value.state as PublicationState) ||
          !Number.isInteger(value.attempts) || Number(value.attempts) < 0 || !ID.test(String(value.artifactId)) || !ID.test(String(value.variantId)) ||
          id !== hash([value.scope, value.artifactId, value.variantId, "subdl"])) throw new Error("invalid");
      publicationMetadata(value.metadata);
      if (!["draft", "cancelled"].includes(String(value.state)) && value.reviewHash !== hash([value.artifactId, value.variantId, value.metadata])) throw new Error("review changed");
      return value as unknown as Publication;
    } catch { throw error("Publication record is missing or invalid"); }
  }
  private save(item: Publication): void {
    item.updatedAt = new Date().toISOString();
    this.library.writePublication(item.id, item);
  }
  list(): Publication[] {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort().map((name) => this.load(name.slice(0, -5)));
  }
  private source(scope: string, artifactId: string, variantId: string, metadata: PublishMetadata) {
    const artifact = this.library.load(scope, artifactId);
    const variant = this.library.variant(scope, artifactId, variantId);
    if (!artifact || !variant) throw error("Only completed library timing variants can be published");
    if (!/^[a-z]{2}$/.test(artifact.targetLanguage)) throw error("SubDL upload language mapping is not verified for this regional or three-letter code");
    const video = variant.metadata.provenance.videoId;
    if (video) {
      const [imdb, season, episode] = video.split(":");
      if (metadata.imdbId !== imdb || (season !== undefined ? metadata.type !== "tv" || metadata.season !== Number(season) || metadata.episode !== Number(episode) : metadata.type !== "movie")) {
        throw error("Publication metadata conflicts with the stored source identity");
      }
    }
    const release = variant.metadata.provenance.release;
    if (release && !metadata.releases.includes(path.basename(release).replace(/\.(mkv|mp4|avi|m4v|srt|vtt)$/i, ""))) {
      throw error("Publication releases must include the stored playback release");
    }
    return { artifact, variant };
  }
  create(scope: string, artifactId: string, variantId: string, input: unknown): Publication {
    const metadata = publicationMetadata(input);
    this.source(scope, artifactId, variantId, metadata);
    const id = hash([scope, artifactId, variantId, "subdl"]);
    if (fs.existsSync(this.file(id))) return this.load(id);
    const item: Publication = { version: 1, id, scope, artifactId, variantId, metadata, state: "draft", attempts: 0, updatedAt: "" };
    this.save(item);
    return item;
  }
  private mutate<T>(id: string, action: () => T): T {
    const lock = this.file(id) + ".lock";
    let fd: number;
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch { throw error("Publication item is locked; stop and reconcile interrupted workers before changing it"); }
    fs.closeSync(fd);
    try { return action(); } finally { fs.rmSync(lock, { force: true }); }
  }
  approve(id: string): Publication {
    return this.mutate(id, () => {
      const item = this.load(id);
      if (item.state !== "draft") throw error("Only a reviewed draft can be approved");
      this.source(item.scope, item.artifactId, item.variantId, item.metadata);
      item.reviewHash = hash([item.artifactId, item.variantId, item.metadata]);
      item.state = "approved"; this.save(item); return item;
    });
  }
  cancel(id: string): Publication {
    return this.mutate(id, () => {
      const item = this.load(id);
      if (["uploading", "uncertain", "submitted", "published-manual", "moderation-rejected"].includes(item.state)) throw error("Reconcile remote state before cancelling this publication");
      item.state = "cancelled"; this.save(item); return item;
    });
  }
  reconcile(id: string, outcome: "not-submitted" | "submitted", workersStopped: boolean): Publication {
    if (!workersStopped) throw error("Stop all upload workers before reconciliation");
    const item = this.load(id);
    if (!["draft", "approved", "uploading", "uncertain", "rejected", "submitted"].includes(item.state) || (item.state === "submitted" && outcome !== "submitted")) throw error("This publication does not need reconciliation");
    if (item.state === "draft" && outcome === "submitted") throw error("An unapproved draft cannot be reconciled as submitted");
    item.state = outcome === "submitted" ? "submitted" : "draft";
    if (outcome === "not-submitted") { delete item.nId; delete item.fileId; }
    delete item.lastError;
    fs.rmSync(this.file(id) + ".lock", { force: true });
    this.save(item); return item;
  }
  recordRejection(id: string, note: string): Publication {
    return this.mutate(id, () => {
      const item = this.load(id);
      if (item.state !== "submitted") throw error("Only submitted items can have a moderation rejection recorded");
      if (!note.trim() || note.length > 1000 || /[\x00-\x1f]/.test(note)) throw error("A bounded plain-text moderation note is required");
      item.state = "moderation-rejected";
      item.moderationNote = note;
      this.save(item);
      return item;
    });
  }
  confirmPublic(id: string, url: string): Publication {
    return this.mutate(id, () => {
      const item = this.load(id);
      if (item.state !== "submitted") throw error("Only submitted items can be manually confirmed public");
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw error("Invalid SubDL public URL"); }
      if (parsed.origin !== "https://subdl.com" || !parsed.pathname.startsWith("/subtitle/") || parsed.username || parsed.password || parsed.search || parsed.hash) throw error("Invalid SubDL public URL");
      item.publicUrl = parsed.toString(); item.state = "published-manual"; this.save(item); return item;
    });
  }
  async submit(id: string, credentials: { token: string; mode: "raw" | "bearer-final" }, transport: typeof fetch = globalThis.fetch): Promise<Publication> {
    if (process.env.SUBDL_PUBLISHING_ENABLED !== "true") throw error("SubDL publishing is disabled");
    let item = this.load(id);
    if (item.state !== "approved" || item.attempts >= 3) throw error("Only approved items with fewer than three attempts can be submitted");
    const { artifact, variant } = this.source(item.scope, item.artifactId, item.variantId, item.metadata);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = this.file(id) + ".lock";
    let fd: number;
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch { throw error("Another upload worker owns this item; reconcile interrupted workers explicitly"); }
    fs.closeSync(fd);
    let started = false;
    try {
      item = this.load(id);
      if (item.state !== "approved" || item.attempts >= 3) throw error("Publication state changed before submission");
      // Persist uncertainty before any request, including across a process crash.
      item.state = "uploading"; item.attempts++; this.save(item); started = true;
      const session = await uploadJson("getNId", credentials.token, undefined, transport);
      if (session.ok !== true || !REMOTE_ID.test(String(session.n_id))) throw new Error("Remote outcome is uncertain");
      item.nId = String(session.n_id); this.save(item);
      const file = new FormData();
      file.set("subtitle", new Blob([variant.srt], { type: "application/x-subrip" }), `${artifact.targetLanguage}-${item.variantId}.srt`);
      file.set("n_id", item.nId);
      const uploaded = await uploadJson("uploadSingleSubtitle", credentials.token, file, transport);
      if (uploaded.ok !== true || !record(uploaded.file) || !REMOTE_ID.test(String(uploaded.file.file_n_id)) ||
          (uploaded.n_id !== undefined && uploaded.n_id !== item.nId)) throw new Error("Remote outcome is uncertain");
      item.fileId = String(uploaded.file.file_n_id); this.save(item);
      const metadata = item.metadata;
      const form = new FormData();
      const comment = `AI-translated by Subtitle Sync; model ${artifact.profile.model}; prompt ${artifact.profile.prompt}; source ${variant.metadata.provenance.source.provider}:${variant.metadata.provenance.source.fileId}; timing ${variant.metadata.provenance.timing}. Credits: ${metadata.credits}. Review: ${metadata.reviewNote}`;
      const fields: Record<string, string> = {
        file_n_ids: JSON.stringify([item.fileId]), n_id: item.nId, type: metadata.type, tmdb_id: String(metadata.tmdbId), imdb_id: metadata.imdbId,
        name: metadata.name, lang: artifact.targetLanguage.toUpperCase(), quality: metadata.quality, production_type: "3",
        releases: JSON.stringify(metadata.releases), framerate: String(metadata.framerate), comment,
        season: String(metadata.season), hi: String(metadata.hearingImpaired), is_full_season: "false",
      };
      if (metadata.type === "tv") { fields.ef = String(metadata.episode); fields.ee = String(metadata.episode); }
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      const token = credentials.mode === "bearer-final" ? `Bearer ${credentials.token}` : credentials.token;
      const result = await uploadJson("uploadSubtitle", token, form, transport);
      if (result.status !== true) throw new Error("Remote outcome is uncertain");
      item.state = "submitted";
      this.save(item);
      return item;
    } catch (failure) {
      if (!started) throw failure;
      item.state = failure instanceof RejectedSubmission ? "rejected" : "uncertain";
      item.lastError = failure instanceof RejectedSubmission ? "SubDL rejected the submission" : "Remote outcome is uncertain; reconcile before any retry";
      this.save(item);
      return item;
    } finally { fs.rmSync(lock, { force: true }); }
  }
}
