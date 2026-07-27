import { spawn } from "node:child_process";

const PROBE_TIMEOUT_MS = 2000;

interface ProbeResult {
  available: boolean;
  path?: string;
  version?: string;
}

/**
 * Find an executable in PATH and verify it can be spawned.
 * Pattern adopted from Paseo (packages/server/src/utils/executable.ts).
 *
 * Uses Bun.which() to locate the binary, then probes by spawning `<bin> --version`
 * with a 2s timeout. Resolves true on the `spawn` event, so even hung CLIs count
 * as "available".
 */
export async function findExecutable(name: string): Promise<string | null> {
  const path = Bun.which(name);
  if (!path) return null;
  const ok = await probeSpawn(path);
  return ok ? path : null;
}

/**
 * Probe an executable by spawning it with `--version`. Returns true if the
 * binary spawns successfully (regardless of exit code or output).
 */
function probeSpawn(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(path, ["--version"], { stdio: "ignore" });
    } catch {
      finish(false);
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(true);
    }, PROBE_TIMEOUT_MS);

    child.on("spawn", () => {
      clearTimeout(timer);
      try { child.kill(); } catch {}
      finish(true);
    });

    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Probe a binary at an absolute path: spawn `<path> --version` and capture the output.
 * Use this when the binary may not be in PATH (e.g. inside a macOS .app bundle).
 */
export async function probeBinaryPath(path: string): Promise<ProbeResult> {
  return probeWithPath(path);
}

function probeWithPath(path: string): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(path, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish({ available: false });
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ available: true, path });
    }, PROBE_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      const output = (stdout || stderr).trim();
      const version = parseVersion(output);
      finish({ available: true, path, version });
    });

    child.on("error", () => {
      clearTimeout(timer);
      finish({ available: false });
    });
  });
}

function parseVersion(output: string): string | undefined {
  if (!output) return undefined;
  // Strip ANSI escapes
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "").trim();
  // First line, or first match of vX.Y.Z / X.Y.Z
  const firstLine = clean.split("\n")[0]?.trim();
  const semver = firstLine?.match(/v?\d+\.\d+(\.\d+)?(-[\w.]+)?/)?.[0];
  return semver || firstLine;
}
