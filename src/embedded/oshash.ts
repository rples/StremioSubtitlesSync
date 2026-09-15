/**
 * The OpenSubtitles file hash.
 *
 * It is the file size plus every 64-bit little-endian word of the first and
 * last 64 KiB, summed and wrapped to 64 bits. That means it can be computed
 * from two small range requests, which is what makes it useful here: 128 KiB
 * is enough to prove that a file found on a debrid account is byte for byte
 * the file Stremio is playing.
 */

const CHUNK = 65536;
const MASK = (1n << 64n) - 1n;

function sumChunk(bytes: Buffer): bigint {
  let total = 0n;
  for (let offset = 0; offset + 8 <= bytes.length; offset += 8) {
    total = (total + bytes.readBigUInt64LE(offset)) & MASK;
  }
  return total;
}

export function hashFromChunks(size: number, head: Buffer, tail: Buffer): string {
  const total = (BigInt(size) + sumChunk(head) + sumChunk(tail)) & MASK;
  return total.toString(16).padStart(16, "0");
}

/** Computes the hash of a remote file using two range requests. */
export async function hashRemoteFile(
  url: string,
  size: number,
  timeoutMs = 20_000,
): Promise<string | null> {
  if (size < CHUNK * 2) return null;

  const range = async (from: number, to: number): Promise<Buffer | null> => {
    const response = await fetch(url, {
      headers: { Range: `bytes=${from}-${to}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Anything but 206 means the server ignored the range and is about to send
    // the whole file. Give up rather than download gigabytes by accident.
    if (response.status !== 206) {
      await response.body?.cancel();
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  };

  const [head, tail] = await Promise.all([
    range(0, CHUNK - 1),
    range(size - CHUNK, size - 1),
  ]);

  if (!head || !tail || head.length < CHUNK || tail.length < CHUNK) return null;
  return hashFromChunks(size, head, tail);
}
