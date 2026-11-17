/**
 * The real environment of the security probes: commands with a deadline, files
 * read read-only. Kept apart from the probes (`machine-security.ts`) so the
 * tests run on recorded output without touching the machine.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { spawnBounded } from "./bounded-spawn";
import { PROBE_TIMEOUT_MS, type ProbeEnv, type RunResult, type Runner } from "./machine-security";

export const runBounded: Runner = async (argv, timeoutMs = PROBE_TIMEOUT_MS) => {
  let proc;
  try {
    proc = spawnBounded(argv, { stdout: "pipe", stderr: "pipe", timeoutMs });
  } catch {
    // Bun throws when the executable does not exist.
    return { code: null, stdout: "", stderr: "", timedOut: false, missing: true } satisfies RunResult;
  }
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr, timedOut: proc.timedOut, missing: false };
};

export function createLocalProbeEnv(appDataDir: string): ProbeEnv {
  return {
    platform: process.platform,
    run: runBounded,
    readFile: async (path) => { try { return await readFile(path, "utf8"); } catch { return null; } },
    listDir: async (path) => { try { return await readdir(path); } catch { return null; } },
    mtimeMs: async (path) => { try { return (await stat(path)).mtimeMs; } catch { return null; } },
    appDataDir,
    now: Date.now,
  };
}
