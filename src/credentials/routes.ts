import express, { Router, type Request } from "express";
import { baseUrl } from "../context";
import { decodeConfig } from "../config";
import { credentialPage } from "./page";
import { CREDENTIAL_FIELDS, createProfile, credentialMode, parseProfile, readProfile, revokeProfile } from "./store";

function secureTransport(req: Request): boolean {
  const peer = req.socket.remoteAddress;
  return req.secure || ((peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(req.hostname));
}

/** Limits registration writes, including clients that rotate/spoof IP addresses. */
export function credentialRoutes(): Router {
  const router = Router();
  let windowStart = Date.now();
  let registrations = 0;
  router.use((req, res, next) => {
    if (credentialMode() === "user" && req.path !== "/health" && !secureTransport(req)) {
      res.status(400).json({ error: "HTTPS is required for personal keys" }); return;
    }
    if (req.path.startsWith("/profiles")) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (credentialMode() !== "user") { res.status(403).json({ error: "Personal keys are disabled by the administrator" }); return; }
      const origin = req.get("origin");
      if (origin && origin !== new URL(baseUrl()).origin) { res.status(403).json({ error: "Cross-origin registration is not allowed" }); return; }
    }
    next();
  });
  router.post("/profiles", express.json({ limit: "32kb" }), (req, res) => {
    if (Date.now() - windowStart >= 3600_000) { registrations = 0; windowStart = Date.now(); }
    if (registrations >= 100) { res.setHeader("Retry-After", "3600"); res.status(429).json({ error: "Registration limit reached" }); return; }
    registrations++;
    try {
      const profile = parseProfile(req.body);
      const token = createProfile(profile);
      const config = encodeURIComponent(JSON.stringify({ profile: token }));
      res.status(201).json({ profile: token, manifestUrl: `${baseUrl()}/${config}/manifest.json` });
    } catch (error) {
      // File-system/crypto errors can include local paths; never return them.
      const message = error instanceof Error ? error.message : "";
      const safe = ["Expected a configuration object", "Unknown or invalid configuration field",
        "Supply your own OpenSubtitles or SubDL API key", "Profile capacity reached; contact the administrator"];
      res.status(safe.includes(message) ? 400 : 503).json({ error: safe.includes(message) ? message : "Profile storage is unavailable" });
    }
  });
  router.post("/profiles/revoke", express.json({ limit: "1kb" }), (req, res) => {
    const token = req.body?.profile;
    if (typeof token !== "string" || !readProfile(token)) { res.status(401).json({ error: "Invalid installation token" }); return; }
    try { revokeProfile(token); res.status(204).end(); }
    catch { res.status(503).json({ error: "Profile storage is unavailable" }); }
  });
  router.get(["/", "/configure", "/:config/configure"], (_req, res, next) => {
    if (credentialMode() !== "user") { next(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.type("html").send(credentialPage());
  });
  // These checks run before caches/SDK resources, so revocation also denies
  // cached files. A bearer installation token is required on every user request.
  router.use((req, res, next) => {
    if (req.path === "/health" || req.path === "/manifest.json") { next(); return; }
    const segment = req.path.split("/")[1];
    let raw: Record<string, unknown> | undefined;
    try {
      const decoded = decodeURIComponent(segment ?? "");
      raw = decoded.startsWith("{") ? JSON.parse(decoded) : decodeConfig(decoded);
    } catch { /* The SDK will reject malformed paths. */ }
    const hasRawKeys = raw && CREDENTIAL_FIELDS.some((field) => Object.hasOwn(raw, field));
    if (hasRawKeys) {
      res.status(400).json({ error: "Keys in installation URLs are no longer accepted; reinstall using /configure" }); return;
    }
    if (credentialMode() === "user" && (!raw || typeof raw.profile !== "string" || !readProfile(raw.profile))) {
      res.setHeader("Cache-Control", "no-store");
      res.status(401).json({ error: "A valid personal installation token is required" }); return;
    }
    if (credentialMode() === "user") {
      // The SDK otherwise overwrites this with public resource-cache headers.
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => setHeader(name,
        name.toLowerCase() === "cache-control" ? "private, no-store" : value);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
    }
    next();
  });
  router.use((_error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    // express.json's error object contains the original request body.
    res.status(400).json({ error: "Invalid or oversized JSON request" });
  });
  return router;
}
