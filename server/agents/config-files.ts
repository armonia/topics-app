/**
 * File helpers shared by `server/agents/registry.ts` and
 * `server/routes/agent-config.ts`, kept in their own module so neither of
 * those two files has to import the other (that import used to form a
 * cycle: registry.ts → agent-config.ts for `safeWrite`, agent-config.ts →
 * registry.ts for `readIdentity`).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { basename, join } from "path";

export const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));

/** Backup then atomic write; returns the backup path. */
export function safeWrite(file: string, data: string, home: string, now = new Date()): string | null {
  const dir = join(home, "backups");
  mkdirSync(dir, { recursive: true });
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = join(dir, `${basename(file)}.${now.toISOString().replace(/[:.]/g, "-")}`);
    copyFileSync(file, backup);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
  return backup;
}
