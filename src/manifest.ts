import { credentialMode } from "./credentials/store";
import type { Manifest } from "stremio-addon-sdk";

export const manifest: Manifest = {
  id: "org.subtitlesync.reference",
  version: "1.0.0",
  name: "Subtitle Sync",
  description:
    "Subtitles from OpenSubtitles and optional SubDL, timed to your exact file. " +
    "A subtitle matched to the video by file hash is used as the timing anchor, " +
    "and every other subtitle is aligned to it before it reaches the player.",
  logo: "https://dl.strem.io/addon-logo.png",
  types: ["movie", "series"],
  resources: ["subtitles"],
  catalogs: [],
  idPrefixes: ["tt"],
  behaviorHints: {
    configurable: true,
    // At least one subtitle provider key is needed, so send new users
    // to /configure instead of letting them install a dead addon.
    configurationRequired: credentialMode() === "user" || (!process.env.OS_API_KEY && !process.env.SUBDL_API_KEY),
  },
  config: [
    {
      key: "languages",
      type: "text",
      title: "Subtitle languages, comma separated",
      default: process.env.LANGUAGES ?? "en",
    },
    {
      key: "anchorLanguages",
      type: "text",
      title: "Languages allowed as the timing anchor",
      default: process.env.ANCHOR_LANGUAGES ?? "en",
    },
    {
      key: "maxPerLang",
      type: "number",
      title: "How many subtitles to offer per language",
      default: process.env.MAX_PER_LANG ?? "5",
    },
    {
      key: "unsynced",
      type: "checkbox",
      title: "Also offer subtitles that could not be synced",
      default: process.env.INCLUDE_UNSYNCED ? "checked" : "",
    },
    {
      key: "labels",
      type: "select",
      // "iso" sends plain language codes, so Stremio files these subtitles
      // under its own "English", "Polski" entries next to other addons'.
      // "verbose" shows the timing method, but each label becomes its own entry.
      title: "Labels",
      options: ["iso", "verbose"],
      default: process.env.LABELS === "verbose" ? "verbose" : "iso",
    },
  ],
};
