/**
 * The text of the server's whole boot, for the tests that read it as source.
 *
 * `server.ts` used to hold the boot in one file. It is now a short chain of stages
 * (`server/boot/*`, run in the order `server.ts` imports them) plus the HTTP front
 * door (`server/routes/front-door.ts` and its parts). A wiring test asks "is X still
 * connected, and before Y?", a question about the boot as a whole, so it reads the
 * pieces joined in boot order: the original statement order survives the split, so
 * an `indexOf` comparison between two statements still means what it meant.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

/** The parts of the HTTP front door, in the order the request meets them. */
const FRONT_DOOR_FILES = [
  "server/routes/front-door.ts",
  "server/routes/daemon-control.ts",
  "server/routes/access-gate.ts",
  "server/routes/static-files.ts",
  "server/routes/ws-open.ts",
  "server/routes/ws-message.ts",
  "server/routes/ws-close.ts",
];

/** Repo-relative paths of every file that holds boot code, `server.ts` first. */
export function serverSourceFiles(): string[] {
  const entry = readFileSync(join(ROOT, "server.ts"), "utf8");
  const stages = [...entry.matchAll(/from "\.\/(server\/boot\/[\w-]+)"/g)].map((m) => `${m[1]}.ts`);
  return ["server.ts", ...stages, ...FRONT_DOOR_FILES, "server/boot/late.ts"].filter((f) => existsSync(join(ROOT, f)));
}

/** The boot code of the server, every file joined in boot order. */
export function readServerSource(): string {
  return serverSourceFiles().map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
}
