import type { OsSubtitle } from "../opensubtitles/types";

/** Provider IDs are namespaced; SubDL cannot claim an OpenSubtitles hash match. */
export type SubtitleCandidate = Omit<OsSubtitle, "fileId"> & {
  provider?: "subdl";
  fileId: number | string;
};
