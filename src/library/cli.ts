import fs from "node:fs";
import { openLibrary, TranslationLibrary } from "./store";
import { TranslationError } from "../translation/config";
import { PublicationQueue, uploadCredentials } from "./publishing";

class CommandError extends Error {}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const library = openLibrary();
  if (!library) throw new CommandError("Set TRANSLATION_LIBRARY_DIR to the persistent library volume");
  const queue = new PublicationQueue(library);
  const required = (index: number): string => {
    const value = args[index];
    if (!value) throw new CommandError("Missing command argument; see docs/LIBRARY.md");
    return value;
  };
  let result: unknown;
  switch (command) {
    case "list": result = library.list(); break;
    case "usage": result = library.usage(); break;
    case "export": library.export(required(0), required(1), required(2), required(3)); result = { exported: true }; break;
    case "delete":
      if (queue.list().some((item) => item.scope === required(0) && item.artifactId === required(1) && !["cancelled", "submitted", "published-manual", "moderation-rejected", "rejected"].includes(item.state))) throw new CommandError("Cancel or reconcile publications before deleting this artifact");
      library.delete(required(0), required(1)); result = { deleted: true }; break;
    case "backup": library.backup(required(0)); result = { backedUp: true }; break;
    case "restore": {
      if (fs.readdirSync(library.root).length) throw new CommandError("Restore requires an empty library directory");
      const source = required(0);
      if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new CommandError("Backup source directory does not exist");
      const manifest = JSON.parse(fs.readFileSync(source + "/backup.json", "utf8"));
      if (manifest.format !== "subtitle-sync-library" || manifest.version !== 1) throw new CommandError("Invalid library backup format");
      const backup = new TranslationLibrary(source);
      if (JSON.stringify(backup.list()) !== JSON.stringify(manifest.entries)) throw new CommandError("Backup contents do not match the completed manifest");
      for (const item of backup.list()) for (const variant of item.variants) backup.variant(item.scope, item.id, variant);
      for (const item of new PublicationQueue(backup).list()) {
        if (["draft", "approved", "uploading", "uncertain"].includes(item.state) && !backup.variant(item.scope, item.artifactId, item.variantId)) {
          throw new CommandError("Active publication refers to missing backup content");
        }
      }
      fs.cpSync(backup.root, library.root, { recursive: true, filter: (file) => !file.endsWith(".lock") && !file.includes(".tmp-") });
      result = { restored: true }; break;
    }
    case "queue": result = queue.create(required(0), required(1), required(2), JSON.parse(fs.readFileSync(required(3), "utf8"))); break;
    case "outbox": result = queue.list(); break;
    case "approve": result = queue.approve(required(0)); break;
    case "cancel": result = queue.cancel(required(0)); break;
    case "submit": result = await queue.submit(required(0), uploadCredentials()); break;
    case "reconcile": {
      const outcome = required(1);
      if (outcome !== "submitted" && outcome !== "not-submitted") throw new CommandError("Reconciliation outcome must be submitted or not-submitted");
      result = queue.reconcile(required(0), outcome, args[2] === "--workers-stopped"); break;
    }
    case "record-rejection": result = queue.recordRejection(required(0), required(1)); break;
    case "confirm-public": result = queue.confirmPublic(required(0), required(1)); break;
    default: throw new CommandError("Commands: list, usage, export, delete, backup, restore, queue, outbox, approve, cancel, submit, reconcile, record-rejection, confirm-public. See docs/LIBRARY.md");
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
main().catch((error: unknown) => {
  // Filesystem errors may embed private paths; token/network errors may contain secrets.
  const message = error instanceof CommandError || error instanceof TranslationError ? error.message : "Library command failed; check storage, arguments and docs/LIBRARY.md";
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
