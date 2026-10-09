/**
 * The Topics MCP bridge for a `muse exec` turn.
 *
 * WHY A STAGED CONFIG. `muse exec` has no `--mcp-config` flag: it reads its
 * servers from `$XDG_CONFIG_HOME/muse/settings.json`. Without this, a Muse chat
 * had the user's global servers (exa, context7, gateway) but not the `topics`
 * bridge, so no browser pane, `run_command`, `spawn_agent`, `close_goal`: the
 * same chat was weaker on Muse than on Claude or Codex. Each turn gets a private
 * copy of the real settings with the bridge added, and the CLI is pointed at it.
 * The same scheme runs in production in the OpenClaw muse-cli backend.
 *
 * Only CONFIG moves: session logs live under `XDG_DATA_HOME`, so resume is
 * untouched. `auth.json`, `trust.json` and `skills` are symlinked, never copied:
 * a refreshed login lands in the real file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** A server entry in Muse's own dialect (`transport`, not `type`). */
export type MuseMcpServer = Record<string, unknown>;

/** The bridge entry for Muse: a stdio server, as `topicsMcpBridgeSpec` describes it. */
export function museBridgeEntry(spec: { command: string; args: string[] }): MuseMcpServer {
  return { transport: "stdio", command: spec.command, args: spec.args };
}

/**
 * The settings this turn runs with: the real ones, plus the bridge under
 * `topics`. The bridge WINS over a same-named user entry: it is bound to this
 * session's key, a global one could not be.
 */
export function mergeMuseSettings(
  real: Record<string, unknown>,
  bridge: MuseMcpServer,
): Record<string, unknown> {
  const servers = (real.mcpServers && typeof real.mcpServers === "object")
    ? real.mcpServers as Record<string, MuseMcpServer>
    : {};
  return { ...real, mcpServers: { ...servers, topics: bridge } };
}

/** Where the user's real Muse config lives. */
export function realMuseConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || "", ".config"), "muse");
}

/**
 * Writes the per-turn config and returns the `XDG_CONFIG_HOME` to spawn with.
 * Throws on a write failure: the caller decides to run without the bridge.
 */
export function stageMuseConfig(
  bridge: MuseMcpServer,
  realDir: string = realMuseConfigDir(),
): { xdgConfigHome: string; cleanup: () => void } {
  const source = join(realDir, "settings.json");
  let real: Record<string, unknown> = {};
  if (existsSync(source)) {
    try { real = JSON.parse(readFileSync(source, "utf8")); } catch { /* malformed: the CLI would refuse it too, start empty */ }
  }
  const xdgConfigHome = mkdtempSync(join(tmpdir(), "topics-muse-xdg-"));
  const cleanup = () => { try { rmSync(xdgConfigHome, { recursive: true, force: true }); } catch { /* an orphan in tmp is harmless */ } };
  try {
    const staged = join(xdgConfigHome, "muse");
    mkdirSync(staged);
    // 0600: the bridge args carry the gateway token.
    writeFileSync(join(staged, "settings.json"), JSON.stringify(mergeMuseSettings(real, bridge)), { mode: 0o600 });
    for (const name of ["auth.json", "trust.json", "skills"]) {
      if (existsSync(join(realDir, name))) symlinkSync(join(realDir, name), join(staged, name));
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  return { xdgConfigHome, cleanup };
}
