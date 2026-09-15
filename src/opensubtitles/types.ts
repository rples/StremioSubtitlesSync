/** One subtitle candidate, flattened out of the OpenSubtitles response shape. */
export interface OsSubtitle {
  subtitleId: string;
  fileId: number;
  fileName: string;
  /** Lowercase OpenSubtitles language code, e.g. "pl", "pt-br". */
  language: string;
  release: string;
  downloadCount: number;
  ratings: number;
  fps: number | null;
  hearingImpaired: boolean;
  aiTranslated: boolean;
  machineTranslated: boolean;
  fromTrusted: boolean;
  /** True when OpenSubtitles matched this subtitle to the exact video file. */
  moviehashMatch: boolean;
}

export interface SearchQuery {
  type: "movie" | "episode";
  /**
   * Numeric IMDb id without the "tt" prefix. For an episode this is the id of
   * the series, which is all Stremio gives us, so it goes out as
   * parent_imdb_id together with the season and episode numbers.
   */
  imdbId: number;
  season?: number | undefined;
  episode?: number | undefined;
  moviehash?: string | undefined;
  languages: string[];
}

export class OpenSubtitlesError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Set when the API asked us to back off. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "OpenSubtitlesError";
  }
}

export class QuotaExceededError extends OpenSubtitlesError {
  constructor(message: string) {
    super(message, 406);
    this.name = "QuotaExceededError";
  }
}
