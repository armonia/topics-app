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
import { resolveClaudeBin } from "./claude-bin";
import { resolveCodexBin } from "./codex-bin";
import { resolveKimiBin } from "./kimi-bin";

export interface AgentPresence {
  /** The session-type id (`shared/terminal-session-types.ts`). */
  id: "claude-code" | "codex" | "opencode" | "kimi-code" | "gemini";
  /** What the people who use it call it. */
  name: string;
  /** The absolute path found, or null. */
  path: string | null;
  installed: boolean;
  /** How to install it, for whoever does not have it. */
  install: string;
  /** The vendor's page, for whoever wants to read before installing. */
  url: string;
}

/**
 * `Bun.which` plus the Windows extensions.
 *
 * On Windows an executable carries its extension, and which one depends on how it
 * was installed: `.exe` for a native installer, `.cmd` for an npm/bun global.
 * Asking for the bare name finds neither — which is why `codex` and `opencode`
 * came back absent even when they were there.
 */
function which(base: string): string | null {
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
  const raw: AgentPresence[] = [
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
      path: which("opencode"),
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
      path: which("gemini"),
      install: "npm i -g @google/gemini-cli",
      url: "https://github.com/google-gemini/gemini-cli",
      installed: false,
    },
  ];
  return raw.map((a) => ({ ...a, installed: a.path !== null }));
}
