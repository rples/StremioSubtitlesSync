import type { Manifest } from "stremio-addon-sdk";

/**
 * The published typings declare `required` as a string. The protocol docs and
 * the SDK's own form renderer both treat it as a boolean, so keep the boolean
 * and paper over the typing here rather than at every use.
 */
const asRequired = (value: boolean): string => value as unknown as string;

export const manifest: Manifest = {
  id: "org.subtitlesync.reference",
  version: "1.0.0",
  name: "Subtitle Sync",
  description:
    "Subtitles from OpenSubtitles, timed to your exact file. " +
    "A subtitle matched to the video by file hash is used as the timing anchor, " +
    "and every other subtitle is aligned to it before it reaches the player.",
  logo: "https://dl.strem.io/addon-logo.png",
  types: ["movie", "series"],
  resources: ["subtitles"],
  catalogs: [],
  idPrefixes: ["tt"],
  behaviorHints: {
    configurable: true,
    // The addon is useless without an OpenSubtitles API key, so send new users
    // to /configure instead of letting them install a dead addon.
    configurationRequired: !process.env.OS_API_KEY,
  },
  config: [
    {
      key: "osApiKey",
      type: "text",
      title: "OpenSubtitles API key (from opensubtitles.com/consumers)",
      required: asRequired(!process.env.OS_API_KEY),
    },
    {
      key: "osUsername",
      type: "text",
      title: "OpenSubtitles username (optional, raises your download quota)",
    },
    {
      key: "osPassword",
      type: "password",
      title: "OpenSubtitles password (optional)",
    },
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
      key: "torboxApiKey",
      type: "password",
      title:
        "TorBox API key (optional). Lets the addon read timings from the video " +
        "itself when OpenSubtitles does not know your file.",
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
