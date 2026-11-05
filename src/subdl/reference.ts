/** SubDL references contain an upload ID and, for unpacked files, a child ID. */
export const SUBDL_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function validSubdlFileId(id: string): boolean {
  const parts = id.split("~");
  return parts.length <= 2 && parts.every((part) => SUBDL_ID.test(part));
}
