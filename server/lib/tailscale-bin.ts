import { existsSync } from "fs";

/**
 * Resolve the `tailscale` CLI binary by absolute path.
 *
 * The server can run under launchd (the production Electron LaunchAgent), where
 * `PATH` is the bare `/usr/bin:/bin:/usr/sbin:/sbin` — it does NOT include
 * Homebrew (`/opt/homebrew/bin`) or the Tailscale.app bundle. So a plain
 * `Bun.spawnSync(["tailscale", …])` fails with ENOENT and the Remote Access
 * panel always reported "no tunnel" even when Tailscale Funnel was live. We
 * probe the known install locations and fall back to the bare name (which still
 * works when the server is launched from a shell with a full PATH, e.g. dev).
 *
 * Order: Homebrew (Apple Silicon → Intel) first since that's the real CLI, then
 * the app bundle, then the system path, then PATH resolution.
 */
const CANDIDATES = [
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/bin/tailscale",
];

let cached: string | null = null;

export function resolveTailscaleBin(): string {
  if (cached) return cached;
  for (const candidate of CANDIDATES) {
    try {
      if (existsSync(candidate)) {
        cached = candidate;
        return cached;
      }
    } catch {
      /* keep probing */
    }
  }
  // Last resort: rely on PATH (works when launched from a shell).
  cached = "tailscale";
  return cached;
}
