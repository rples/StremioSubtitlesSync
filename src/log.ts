import fs from "node:fs";
import { inspect } from "node:util";

type Level = "debug" | "info" | "warn" | "error";

let file: fs.WriteStream | null = null;

/** Also appends every line to a file, so the log can be read after the terminal is gone. */
export function logToFile(path: string): void {
  const stream = fs.createWriteStream(path, { flags: "a" });
  stream.on("error", (error) => {
    // A broken log file must never take the server down with it.
    if (file === stream) file = null;
    console.error(`log file ${path} unavailable: ${error.message}`);
  });
  file = stream;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;

function emit(level: Level, message: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (extra === undefined) console.log(line);
  else console.log(line, extra);
  file?.write(extra === undefined ? `${line}\n` : `${line} ${inspect(extra)}\n`);
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};

/** Keeps API keys and passwords out of the log when a URL or config is printed. */
export function redact(value: string): string {
  return value.replace(/([?&](?:api_?key|token|password)=)[^&]+/gi, "$1***");
}
