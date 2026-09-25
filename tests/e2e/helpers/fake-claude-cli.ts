/**
 * Puts `fake-claude-slow-turn.ts` in front of the test server's CLI, for one
 * spec.
 *
 * The server resolves the CLI at EVERY spawn (`resolveCliPath` in
 * server/providers/claude-code.ts), and it looks under the versions folder of
 * its HOME before the launcher stub that `scripts/start-test-server.sh`
 * writes. So an entry there wins from the next spawn on, with no restart, and
 * removing it gives the stub back. The suite runs one worker per server, so no
 * other spec spawns a CLI while it is installed; sessions spawned before it
 * keep the child they have.
 */
import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { E2E_HOME } from "./test-server";

const VERSIONS_DIR = join(E2E_HOME, ".local", "share", "claude", "versions");
/** Sorted above any real version: the resolver takes the highest. */
const ENTRY = join(VERSIONS_DIR, "999.0.0-e2e");
const SCRIPT = resolve(__dirname, "fake-claude-slow-turn.ts");

/** Installs the slow-turn CLI; returns its removal. */
export function installSlowTurnCli(): () => void {
  // The server spawns the CLI with a trimmed environment, so the wrapper names
  // bun by its absolute path instead of trusting that PATH has it.
  const bun = execSync("command -v bun").toString().trim();
  mkdirSync(VERSIONS_DIR, { recursive: true });
  writeFileSync(ENTRY, `#!/usr/bin/env bash\nexec "${bun}" "${SCRIPT}" "$@"\n`);
  chmodSync(ENTRY, 0o755);
  return () => rmSync(ENTRY, { force: true });
}
