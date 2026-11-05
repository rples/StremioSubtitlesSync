import { artifactIdentity, hash, openLibrary, type LibraryContext } from "../library/store";
import { credentialMode } from "../credentials/store";
import { Router } from "express";
import { decodeConfig, resolveConfig, type ResolvedConfig } from "../config";
import { toSrt, toVtt } from "../subtitles/serialize";
import { LANGUAGE, TranslationError } from "./config";
import { parseSourceJob, sourceCues } from "./source";
import { translatedCues } from "./service";

function libraryScope(config: ResolvedConfig, profile: string | undefined): string {
  if (config.shareLibrary) return "instance";
  if (credentialMode() === "user") return `user-${hash(profile)}`;
  return "server";
}

export function translationRoutes(): Router {
  const router = Router();
  router.get("/:cfg/t/:target/:job/:name", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const raw = decodeConfig(req.params.cfg);
      const config = resolveConfig(raw);
      if (!config.translation) throw new TranslationError("AI translation is not enabled for this installation", 403);
      const target = req.params.target ?? "";
      if (!LANGUAGE.test(target) || !config.languages.includes(target)) throw new TranslationError("Translation target is not configured", 400);
      const job = parseSourceJob(req.params.job ?? "");
      if (!config.translation.sourceLanguages.includes(job.file.lang) || target === job.file.lang) {
        throw new TranslationError("Unsupported translation source language", 400);
      }
      const cues = await sourceCues(config, job);
      const context: LibraryContext = {
        scope: libraryScope(config, raw?.profile),
        timing: job.timing, source: { provider: job.file.provider ?? "opensubtitles", fileId: String(job.file.fileId), language: job.file.lang },
        ...(job.videoId ? { videoId: job.videoId } : {}), ...(job.release ? { release: job.release } : {}),
        ...(job.videoHash ? { videoHash: job.videoHash } : {}), ...(job.videoSize ? { videoSize: job.videoSize } : {}),
      };
      const result = await translatedCues(cues, job.file.lang, target, config.translation, globalThis.fetch, context);
      const library = openLibrary();
      if (library) {
        const id = artifactIdentity(cues, job.file.lang, target, config.translation).id;
        const artifact = library.load(context.scope, id)!;
        const variant = library.saveVariant(context.scope, artifact, cues, context);
        res.setHeader("X-Subtitle-Library", id);
        res.setHeader("X-Subtitle-Timing-Variant", variant.id);
      }
      const vtt = req.params.name?.endsWith(".vtt");
      res.setHeader("X-Subtitle-Translation", "AI; timing inherited from source");
      res.setHeader("X-Subtitle-Sync", job.timing);
      res.type(vtt ? "text/vtt" : "application/x-subrip").send(vtt ? toVtt(result) : toSrt(result));
    } catch (error) {
      // Provider/network failures may contain URLs or response bodies. Never echo them.
      const safe = error instanceof TranslationError ? error : new TranslationError("Translation source is unavailable", 503, 30);
      if (safe.retryAfterSeconds) res.setHeader("Retry-After", String(safe.retryAfterSeconds));
      res.status(safe.status).type("text/plain").send(safe.message);
    }
  });
  return router;
}
