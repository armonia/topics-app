/**
 * Which command-line agents are INSTALLED on this machine.
 *
 * Topics runs the CLIs the user already has: it does not bundle them and cannot
 * (they are the vendors' own installs, with the vendors' own accounts). Until now
 * nothing asked this question before trying, and the result was a tab that opened
 * and stayed empty — on macOS the shell at least printed "command not found", on
 * Windows not even that: the process never started and the PTY hit EOF in the
 * same instant.
 *
 * Needed in two places, and it is the same fact: the "+" menu should be able to
 * show what is missing instead of just offering it, and first-run setup should be
 * able to say "found Claude Code, did not find Codex" with the install command.
 *
 * Installs nothing and touches nothing: this is a read.
 */
import { existsSync } from "fs";
import { resolveClaudeBin, _resetClaudeBinCache } from "./claude-bin";
import { resolveCodexBin, _resetCodexBinCache } from "./codex-bin";
import { resolveKimiBin, _resetKimiBinCache } from "./kimi-bin";
import {
  CLI_AGENT_BIN_NAMES,
  agentBinPath,
  expandHome,
  readAgentBinPaths,
  type CliAgentId,
} from "./agent-bin-paths";

export interface AgentPresence {
  /** The session-type id (`shared/terminal-session-types.ts`). */
  id: CliAgentId;
  /** What the people who use it call it. */
  name: string;
  /** The absolute path found, or null. */
  path: string | null;
  installed: boolean;
  /** How to install it, for whoever does not have it. */
  install: string;
  /** The vendor's page, for whoever wants to read before installing. */
  url: string;
  /**
   * The path somebody typed in Settings, exactly as they typed it, or null.
   *
   * Separate from `path`, which is where the binary was FOUND: the two differ
   * when the manual path stopped resolving (the CLI was moved or uninstalled),
   * and that is precisely the case the UI has to be able to show and clear.
   */
  manualPath: string | null;
  /** Whether that manual path still points at something. */
  manualPathBroken: boolean;
  /**
   * The file name the CLI installs itself as (`claude`, not `claude-code`). The
   * UI needs it to tell somebody what to type into `which`, and guessing it from
   * the display name is a guess that breaks the day a name gains a word.
   */
  bin: string;
}

/**
 * `Bun.which` plus the Windows extensions.
 *
 * On Windows an executable carries its extension, and which one depends on how it
 * was installed: `.exe` for a native installer, `.cmd` for an npm/bun global.
 * Asking for the bare name finds neither — which is why `codex` and `opencode`
 * came back absent even when they were there.
 */
function which(base: string, id: CliAgentId): string | null {
  const chosen = agentBinPath(id);
  if (chosen) return chosen;
  const names = process.platform === "win32"
    ? [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base]
    : [base];
  for (const n of names) {
    const p = Bun.which(n);
    if (p) return p;
  }
  return null;
}

/**
 * The state of every agent. The order is the one that makes sense to present:
 * the one Topics uses by default comes first.
 */
export function detectAgents(): AgentPresence[] {
  // The probe result only. `manualPath` / `manualPathBroken` are added below,
  // in one pass over the stored overrides, so no entry can forget them.
  const raw: Omit<AgentPresence, "manualPath" | "manualPathBroken" | "bin">[] = [
    {
      id: "claude-code",
      name: "Claude Code",
      path: resolveClaudeBin(),
      install: "https://claude.com/product/claude-code",
      url: "https://claude.com/product/claude-code",
      installed: false,
    },
    {
      id: "codex",
      name: "Codex",
      path: resolveCodexBin(),
      install: "npm i -g @openai/codex",
      url: "https://developers.openai.com/codex/cli",
      installed: false,
    },
    {
      id: "opencode",
      name: "opencode",
      // No dedicated resolver: opencode installs from npm and lives on PATH.
      path: which("opencode", "opencode"),
      install: "npm i -g opencode-ai",
      url: "https://opencode.ai",
      installed: false,
    },
    {
      id: "kimi-code",
      name: "Kimi Code",
      path: resolveKimiBin(),
      install: "curl https://code.kimi.com/kimi-code/install.sh | bash",
      url: "https://code.kimi.com",
      installed: false,
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      path: which("gemini", "gemini"),
      install: "npm i -g @google/gemini-cli",
      url: "https://github.com/google-gemini/gemini-cli",
      installed: false,
    },
  ];
  const manual = readAgentBinPaths();
  return raw.map((a) => {
    const manualPath = manual[a.id] ?? null;
    return {
      ...a,
      installed: a.path !== null,
      manualPath,
      manualPathBroken: manualPath !== null && !existsSync(expandHome(manualPath)),
      bin: CLI_AGENT_BIN_NAMES[a.id],
    };
  });
}

/**
 * Forget where the binaries were, so the next `detectAgents()` looks again.
 *
 * Every resolver memoizes its answer, which is right for a path that does not
 * move and wrong the moment somebody points at one by hand or installs the CLI
 * while the app is open: without this the new path would take effect at the next
 * restart, which is the restart the whole feature exists to avoid. It lives here
 * because this is the module that already imports all three resolvers.
 */
export function resetAgentBinCaches(): void {
  _resetClaudeBinCache();
  _resetCodexBinCache();
  _resetKimiBinCache();
}
