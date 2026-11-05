import { artifactIdentity, openLibrary, type LibraryContext } from "../library/store";
import { createHash } from "node:crypto";
import { TtlCache } from "../cache";
import type { Cue } from "../subtitles/types";
import { LANGUAGE, TranslationError, type TranslationSettings } from "./config";
import { translateBatch, type TextCue } from "./client";

const completed = new TtlCache<string[]>(60 * 60_000, 50);
const cooldown = new TtlCache<number>(60_000, 200);
const pending = new Map<string, Promise<string[]>>();
let calls = 0;
let reserved = 0;
let windowStart = Date.now();

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function batches(cues: Cue[], settings: TranslationSettings): TextCue[][] {
  if (!cues.length || cues.length > settings.maxCues || cues.reduce((sum, cue) => sum + cue.text.length, 0) > settings.maxCharacters ||
      cues.some((cue) => !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || !cue.text.trim())) {
    throw new TranslationError("Subtitle exceeds AI limits or has invalid cues", 400);
  }
  const out: TextCue[][] = [];
  let batch: TextCue[] = [];
  let characters = 0;
  for (const [index, cue] of cues.entries()) {
    if (cue.text.length > settings.batchCharacters) throw new TranslationError("One subtitle cue exceeds the AI batch limit", 400);
    if (batch.length && (batch.length >= settings.batchCues || characters + cue.text.length > settings.batchCharacters)) {
      out.push(batch); batch = []; characters = 0;
    }
    batch.push({ id: index + 1, text: cue.text }); characters += cue.text.length;
  }
  if (batch.length) out.push(batch);
  return out;
}

/** A selected subtitle starts a bounded background job shared by repeat fetches. */
export async function translatedCues(
  cues: Cue[], source: string, target: string, settings: TranslationSettings,
  transport: typeof fetch = globalThis.fetch,
  context?: LibraryContext,
): Promise<Cue[]> {
  if (!LANGUAGE.test(source) || !LANGUAGE.test(target) || source === target || !settings.sourceLanguages.includes(source)) {
    throw new TranslationError("Unsupported translation language pair", 400);
  }
  const parts = batches(cues, settings);
  const scope = digest([settings.baseUrl, settings.apiKey, settings.headers]);
  const library = context ? openLibrary() : undefined;
  const identity = artifactIdentity(cues, source, target, settings);
  const memoryKey = digest([scope, identity.id]);
  const key = library ? `${library.root}:${context!.scope}:${identity.id}` : memoryKey;
  const saved = library?.load(context!.scope, identity.id);
  let texts = library ? saved?.texts : completed.get(key);
  if (!texts) {
    let task = pending.get(key);
    if (!task) {
      const until = cooldown.get(scope);
      if (until) throw new TranslationError("AI endpoint is cooling down", 429, Math.max(1, Math.ceil((until - Date.now()) / 1000)));
      if (pending.size >= settings.concurrency) throw new TranslationError("AI worker is busy", 503, 5);
      if (Date.now() - windowStart >= 3600_000) { calls = 0; windowStart = Date.now(); }
      if (calls + reserved + parts.length > settings.hourlyCalls) {
        throw new TranslationError("AI hourly request limit reached", 429,
          Math.max(1, Math.ceil((windowStart + 3600_000 - Date.now()) / 1000)));
      }
      const releaseSpace = library?.reserve(cues);
      reserved += parts.length;
      let remaining = parts.length;
      task = Promise.resolve().then(async () => {
        try {
          const signal = AbortSignal.timeout(settings.jobTimeoutMs);
          const result: string[] = [];
          for (const part of parts) {
            signal.throwIfAborted();
            if (Date.now() - windowStart >= 3600_000) { calls = 0; windowStart = Date.now(); }
            reserved--; remaining--; calls++;
            result.push(...await translateBatch(part, source, target, settings, signal, transport));
          }
          if (library) {
            releaseSpace?.();
            const artifact = library.save(context!.scope, identity, result);
            library.saveVariant(context!.scope, artifact, cues, context!);
            return artifact.texts;
          }
          completed.set(key, result);
          return result;
        } catch (error) {
          const safe = error instanceof TranslationError ? error : new TranslationError("AI job failed or timed out", 503, 60);
          const pauseMs = (safe.retryAfterSeconds ?? 60) * 1000;
          cooldown.set(scope, Date.now() + pauseMs, pauseMs);
          throw safe;
        } finally { releaseSpace?.(); reserved -= remaining; pending.delete(key); }
      });
      pending.set(key, task);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      texts = await Promise.race([task, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TranslationError("Translation is preparing; select it again shortly", 503, 5)), settings.responseWaitMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  const result = cues.map((cue, index) => ({ ...cue, text: texts![index]! }));
  if (library) {
    const artifact = library.load(context!.scope, identity.id);
    if (!artifact) throw new TranslationError("Completed translation is missing from the library", 503, 30);
    library.saveVariant(context!.scope, artifact, cues, context!);
  }
  return result;
}
