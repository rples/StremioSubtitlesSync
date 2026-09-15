/**
 * A stream source is anything that can find the video file again.
 *
 * Stremio never tells a subtitles addon where the stream came from, so to read
 * the file we have to rediscover it ourselves. Everything a source gets to work
 * with is what Stremio sent: the file's size, its name, and its hash.
 */

export interface FileHint {
  filename: string | undefined;
  /** Exact byte size. The strongest signal we have, so sources match on it first. */
  videoSize: number | undefined;
  videoHash: string | undefined;
}

export interface ResolvedFile {
  /** A direct URL that supports HTTP range requests. */
  url: string;
  name: string;
  size: number;
  /** Which source produced this, for logging. */
  source: string;
  /**
   * True when the source already proved this is the right file, by supplying an
   * OpenSubtitles hash that matched. The caller can then skip its own check.
   */
  verified: boolean;
}

export interface StreamSource {
  readonly name: string;
  /**
   * Candidates for the file, best guess first.
   *
   * A source is allowed to be generous here: the caller confirms each candidate
   * against the OpenSubtitles hash before reading anything from it, so a wrong
   * guess costs two range requests and nothing more.
   */
  resolve(hint: FileHint): Promise<ResolvedFile[]>;
}
