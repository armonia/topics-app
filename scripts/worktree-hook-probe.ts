/**
 * WORKTREE HOOK PROBE: the real Claude Code, once (change worktree-standard, T10).
 *
 * The unit and shell tests prove the hook script against a payload written by
 * hand. This asks the real CLI to use it: a temporary repository, a temporary
 * TOPICS_HOME with no server, and ONE session that makes the worktree and then
 * removes it,
 *
 *   claude -p "<call ExitWorktree remove>" --worktree probe-x --settings <json>
 *     --permission-mode bypassPermissions --max-turns 6
 *
 * `claude -p` never runs WorktreeRemove at the end of a session: the deferred
 * ExitWorktree tool is the one way to reach it in print mode (it spends a turn
 * on ToolSearch first, hence the turns). The settings point at a wrapper that
 * logs each payload, the hook's exit code and, right after the create, what git
 * and the ledger say, then hands the payload to the real script.
 *
 * It exits 1 when, after the create, the working directory the CLI reports is
 * not `{TOPICS_HOME}/worktrees/{slug}/probe-x`, `git worktree list` does not
 * show it locked as `claude-code:<session>` or its ledger entry is missing;
 * and when, after the remove, the folder, the ledger entry or git's entry is
 * still there, or the tag `archive/wt-probe-x` is not. With `--unwritable-root`
 * the root refuses writes and the checkout must land in Claude Code's own
 * `<repo>/.claude/worktrees/probe-x`. It prints the remove payload's session and
 * cwd next to the create's: the hook's remove check keys on that session id.
 *
 * By hand, never in CI: it spends a few tokens of a real session. The temporary
 * repository and home are removed at the end, pass or fail.
 *
 *   bun scripts/worktree-hook-probe.ts [--keep] [--unwritable-root]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { topicsWorktreeHooksSettings } from "../server/lib/topics-hooks";

const NAME = "probe-x";
const keep = process.argv.includes("--keep");
const unwritableRoot = process.argv.includes("--unwritable-root");

function fail(message: string): never {
  console.error(`worktree-hook-probe: FAIL ${message}`);
  process.exit(1);
}

/** A file the wrapper wrote, or "" when it did not. */
function logged(dir: string, file: string): string {
  try { return readFileSync(join(dir, file), "utf8").trim(); } catch { return ""; }
}

const base = realpathSync(mkdtempSync(join(tmpdir(), "wt-probe-")));
const root = join(base, "home", "worktrees");
try {
  const home = join(base, "home");
  const repo = join(base, "Probe Repo");
  const logs = join(base, "logs");
  mkdirSync(join(home, "claude-hooks"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(logs, { recursive: true });

  // Git identity and hooks of the probe, not of the machine that runs it.
  // An index-signature type, so `delete` on a key the platform's env type does not name still checks.
  const gitEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(base, "gitconfig"),
    TOPICS_HOME: home,
    TOPICS_APP_URL: "http://127.0.0.1:9",
    PROBE_LOGS: logs,
    PROBE_REPO: repo,
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
  // The wrapper the settings name: it logs, then runs the real script with the same verb.
  const wrapper = join(home, "claude-hooks", "probe-hook.sh");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    'in="$(cat)"',
    'printf "%s\\n" "$in" > "$PROBE_LOGS/$1.payload.json"',
    `out="$(printf "%s" "$in" | sh ${JSON.stringify(script)} "$@")"; code=$?`,
    'printf "%s\\n" "$code" > "$PROBE_LOGS/$1.exit"',
    'if [ "$1" = create ]; then',
    '  git -C "$PROBE_REPO" worktree list --porcelain > "$PROBE_LOGS/create.list"',
    '  find "$TOPICS_HOME/worktrees/.topics-owned" -type f > "$PROBE_LOGS/create.ledger" 2>/dev/null',
    "fi",
    'printf "%s\\n" "$out"',
    "exit $code",
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o755);
  const settings = join(base, "settings.json");
  writeFileSync(settings, JSON.stringify(topicsWorktreeHooksSettings(wrapper)));
  if (unwritableRoot) { mkdirSync(root, { recursive: true }); chmodSync(root, 0o500); }

  const run = spawnSync(
    "claude",
    [
      "-p", 'Call the ExitWorktree tool with action "remove" and discard_changes true, then reply with the single word ok.',
      "--worktree", NAME, "--settings", settings, "--permission-mode", "bypassPermissions",
      "--output-format", "stream-json", "--verbose", "--max-turns", "6",
    ],
    { cwd: repo, env: gitEnv, encoding: "utf8", timeout: 300_000 },
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

  // --- what the create left, read while the session still had it ----------------
  const slug = basename(repo).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const wanted = unwritableRoot ? join(repo, ".claude", "worktrees", NAME) : join(root, slug, NAME);
  if (logged(logs, "create.exit") !== "0") fail(`the create hook exited ${logged(logs, "create.exit") || "never"}`);
  const got = existsSync(cwd) ? realpathSync(cwd) : cwd;
  if (got !== wanted) fail(`the session ran in ${got}, wanted ${wanted}`);
  const entry = logged(logs, "create.list").split("\n\n").find((block) => block.split("\n")[0] === `worktree ${wanted}`);
  if (!entry) fail(`git worktree list did not show ${wanted} after the create`);
  const lock = entry.split("\n").find((l) => l.startsWith("locked"));
  if (!lock?.includes("claude-code:")) fail(`the checkout was not locked by claude-code: (${lock ?? "no lock"})`);
  const ledger = join(root, ".topics-owned", slug, NAME);
  const ledgerAtCreate = logged(logs, "create.ledger").split("\n").includes(ledger);
  if (!unwritableRoot && !ledgerAtCreate) fail(`no ledger entry ${ledger} after the create`);

  // --- what the remove left --------------------------------------------------------
  const removePayload = logged(logs, "remove.payload.json");
  if (!removePayload) fail(`the CLI never called WorktreeRemove (exit ${run.status}): ${run.stdout.split("\n").slice(-3).join(" ").slice(0, 300)}`);
  if (logged(logs, "remove.exit") !== "0") fail(`the remove hook exited ${logged(logs, "remove.exit")}`);
  if (existsSync(wanted)) fail(`the folder ${wanted} is still there after the remove`);
  if (existsSync(ledger)) fail(`the ledger entry ${ledger} is still there after the remove`);
  if (git(repo, "worktree", "list", "--porcelain").includes(`worktree ${wanted}\n`)) fail("git still lists the worktree after the remove");
  const tag = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/archive/wt-${NAME}`], { cwd: repo, env: gitEnv, encoding: "utf8" });
  if (tag.status !== 0) fail(`no tag archive/wt-${NAME} after the remove`);

  const create = JSON.parse(logged(logs, "create.payload.json")) as { session_id?: string; cwd?: string };
  const remove = JSON.parse(removePayload) as { session_id?: string; cwd?: string; worktree_path?: string };
  const hide = (p: string | undefined) => (p ?? "").replace(base, "<tmp>");
  console.log(JSON.stringify({
    ok: true, cwd: hide(got), lock: lock.replace(session, "<session>"), sessionReported: session !== "",
    remove: { sameSessionAsCreate: remove.session_id === create.session_id, cwd: hide(remove.cwd), worktreePath: hide(remove.worktree_path) },
  }));
} finally {
  if (unwritableRoot) { try { chmodSync(root, 0o700); } catch { /* never made */ } }
  if (!keep) rmSync(base, { recursive: true, force: true });
}
