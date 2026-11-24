/**
 * WORKTREE HOOK PROBE: the real Claude Code, once (change worktree-standard, T10).
 *
 * The unit and shell tests prove the hook script against a payload written by
 * hand. This asks the real CLI to use it: a temporary repository, a temporary
 * TOPICS_HOME with no server, and
 *
 *   claude -p --worktree probe-x --settings <json with the two worktree events>
 *
 * with a one-word prompt. It exits 1 when the working directory the CLI
 * reports is not `{TOPICS_HOME}/worktrees/{slug}/probe-x`, or when `git
 * worktree list` does not show the checkout locked as `claude-code:<session>`.
 *
 * By hand, never in CI: it spends a few tokens of a real session. The temporary
 * repository and home are removed at the end, pass or fail.
 *
 *   bun scripts/worktree-hook-probe.ts [--keep]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { topicsWorktreeHooksSettings } from "../server/lib/topics-hooks";

const NAME = "probe-x";
const keep = process.argv.includes("--keep");

function fail(message: string): never {
  console.error(`worktree-hook-probe: FAIL ${message}`);
  process.exit(1);
}

const base = realpathSync(mkdtempSync(join(tmpdir(), "wt-probe-")));
try {
  const home = join(base, "home");
  const repo = join(base, "Probe Repo");
  mkdirSync(join(home, "claude-hooks"), { recursive: true });
  mkdirSync(repo, { recursive: true });

  // Git identity and hooks of the probe, not of the machine that runs it.
  // An index-signature type, so `delete` on a key the platform's env type does not name still checks.
  const gitEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(base, "gitconfig"),
    TOPICS_HOME: home,
    TOPICS_APP_URL: "http://127.0.0.1:9",
  };
  delete gitEnv.TOPICS_WORKTREES_DIR;
  writeFileSync(join(base, "gitconfig"), "[user]\n\tname = probe\n\temail = probe@example.invalid\n[init]\n\tdefaultBranch = main\n");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "one");

  // The script exactly as the server writes it next to its token: executable, in TOPICS_HOME.
  const script = join(home, "claude-hooks", "worktree-hook.sh");
  copyFileSync(join(import.meta.dir, "claude-hooks", "worktree-hook.sh"), script);
  chmodSync(script, 0o755);
  const settings = join(base, "settings.json");
  writeFileSync(settings, JSON.stringify(topicsWorktreeHooksSettings(script)));

  const run = spawnSync(
    "claude",
    ["-p", "Reply with the single word ok.", "--worktree", NAME, "--settings", settings, "--output-format", "stream-json", "--verbose", "--max-turns", "1"],
    { cwd: repo, env: gitEnv, encoding: "utf8", timeout: 180_000 },
  );
  if (run.error) fail(`could not run claude: ${run.error.message}`);

  let cwd = "";
  let session = "";
  for (const line of run.stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: string; subtype?: string; cwd?: string; session_id?: string };
      if (event.type === "system" && event.subtype === "init") {
        cwd = event.cwd ?? "";
        session = event.session_id ?? "";
        break;
      }
    } catch { /* not a JSON line */ }
  }
  if (!cwd) fail(`no init event with a cwd (exit ${run.status}): ${run.stderr.trim().slice(0, 300)}`);

  const slug = basename(repo).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const wanted = join(home, "worktrees", slug, NAME);
  const got = realpathSync(cwd);
  if (got !== wanted) fail(`the session ran in ${got}, wanted ${wanted}`);

  const listing = git(repo, "worktree", "list", "--porcelain");
  const entry = listing.split("\n\n").find((block) => block.split("\n")[0] === `worktree ${wanted}`);
  if (!entry) fail(`git worktree list does not show ${wanted}`);
  const lock = entry.split("\n").find((l) => l.startsWith("locked"));
  if (!lock?.includes("claude-code:")) fail(`the checkout is not locked by claude-code: (${lock ?? "no lock"})`);

  console.log(JSON.stringify({ ok: true, cwd: got.replace(base, "<tmp>"), lock: lock.replace(session, "<session>"), sessionReported: session !== "" }));
} finally {
  if (!keep) rmSync(base, { recursive: true, force: true });
}
