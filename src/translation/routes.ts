import { Router } from "express";
import { decodeConfig, resolveConfig } from "../config";
import { toSrt, toVtt } from "../subtitles/serialize";
import { LANGUAGE, TranslationError } from "./config";
import { parseSourceJob, sourceCues } from "./source";
import { translatedCues } from "./service";

export function translationRoutes(): Router {
  const router = Router();
  router.get("/:cfg/t/:target/:job/:name", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      const config = resolveConfig(decodeConfig(req.params.cfg));
      if (!config.translation) throw new TranslationError("AI translation is not enabled for this installation", 403);
      const target = req.params.target ?? "";
      if (!LANGUAGE.test(target) || !config.languages.includes(target)) throw new TranslationError("Translation target is not configured", 400);
      const job = parseSourceJob(req.params.job ?? "");
      if (!config.translation.sourceLanguages.includes(job.file.lang) || target === job.file.lang) {
        throw new TranslationError("Unsupported translation source language", 400);
      }
      const cues = await sourceCues(config, job);
      const result = await translatedCues(cues, job.file.lang, target, config.translation);
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
