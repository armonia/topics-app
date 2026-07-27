import { spawn } from "node:child_process";

const PROBE_TIMEOUT_MS = 2000;

interface ProbeResult {
  available: boolean;
  path?: string;
  version?: string;
}

/**
 * Probe a binary at an absolute path: spawn `<path> --version` and capture the output.
 * Use this when the binary may not be in PATH (e.g. inside a macOS .app bundle).
 *
 * C'era anche un `findExecutable(name)` (Bun.which + probe senza output) con il
 * suo `probeSpawn`: nessun chiamante in tutto il repo, rimossi.
 */
export function probeBinaryPath(path: string): Promise<ProbeResult> {
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

    child.on("close", () => {
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
