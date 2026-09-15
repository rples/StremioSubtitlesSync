/**
 * `serveHTTP` builds the landing and /configure pages, but `getRouter` does
 * not. This addon mounts its own routes alongside the SDK router, so it needs
 * the template directly. The package does not re-export it and ships no types
 * for the deep path, hence this declaration.
 */
declare module "stremio-addon-sdk/src/landingTemplate" {
  import type { Manifest } from "stremio-addon-sdk";
  function landingTemplate(manifest: Manifest): string;
  export = landingTemplate;
}
