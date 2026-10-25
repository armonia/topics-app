/**
 * The delivery-report verifier asks the repository the report talks about.
 *
 * It used to ask this server's own checkout, whatever the card's project:
 * a dancerooms commit was "in no ref", a file that existed only on the
 * delivery branch "not tracked". Four true deliveries were accused on
 * 2026-09-04 before noon. The service now asks the host where the card's
 * repository is (worktree first, then project) and builds the probe there.
 *
 * @covers KANBAN-11
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createTaskService, deliveryNotesInFlight, type TaskService } from "./tasks";
import { freshDb, PID } from "./tasks-test-db";
import type { RepoProbe } from "./deliveryReportChecks";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const silentProbe: RepoProbe = {
  shaExists: () => true,
  migrations: () => [],
  readMigration: () => "",
  fileMatches: () => true,
  readLine: () => null,
  symbolInHistory: () => true,
};

describe("the delivery verifier probes the card's repository", () => {
  let db: Database;
  let s: TaskService;
  const asked: Array<{ taskId: string; projectId: string | undefined; assignedTopicId: string | null }> = [];
  const built: string[] = [];
  const fileMatches: string[] = [];

  beforeEach(() => {
    db = freshDb();
    asked.length = 0; built.length = 0; fileMatches.length = 0;
    s = createTaskService(db, {
      repoRootFor: (args) => { asked.push(args); return args.assignedTopicId ? "/worktrees/of/the-card" : "/projects/of/the-board"; },
      probeFor: (root) => {
        built.push(root);
        return { ...silentProbe, fileMatches: (c) => { fileMatches.push(c); return false; } };
      },
    });
  });

  test("a bound card is checked in its worktree, and the report's file claims go to THAT probe", () => {
    db.run("INSERT INTO topics (id) VALUES ('topic-1')");
    const t = s.create({ projectId: PID, text: "Una card", status: "in_progress" });
    db.run("UPDATE tasks SET assigned_topic_id = 'topic-1' WHERE id = ?", [t.id]);

    s.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review", summary: "Nuovo helper in `client/src/lib/terminalActions.ts` con i test accanto." } });

    expect(asked).toEqual([{ taskId: t.id, projectId: PID, assignedTopicId: "topic-1" }]);
    expect(built).toEqual(["/worktrees/of/the-card"]);
    expect(fileMatches).toContain("client/src/lib/terminalActions.ts");
    // The accusation, when there is one, comes from the card's own repository.
    const note = s.get(t.id)!.comments.find((c) => c.kind === "review-note");
    expect(note?.content).toContain("client/src/lib/terminalActions.ts");
  });

  test("an unbound card is checked in the board's project, never in this server's checkout", () => {
    const t = s.create({ projectId: PID, text: "Una card di un altro repo", status: "in_progress" });

    s.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review", summary: "Vedi `server/src/field.js`." } });

    expect(asked[0]?.assignedTopicId).toBeNull();
    expect(built).toEqual(["/projects/of/the-board"]);
  });

  test("the host project roots and the card worktree are sent to SHA preparation", async () => {
    let searchedRoots: readonly string[] | undefined;
    const probe: RepoProbe = {
      ...silentProbe,
      prepare: async (_reports, context) => {
        searchedRoots = context?.knownRoots;
        return silentProbe;
      },
    };
    const service = createTaskService(db, {
      repoRootFor: () => "/worktrees/of/the-card",
      listRepoRoots: () => ["/projects/one", "/projects/two"],
      probeFor: () => probe,
    });
    const task = service.create({ projectId: PID, text: "Cross-repo delivery", status: "in_progress" });

    service.update({ taskId: task.id, actor: "agent", by: "agent-1", patch: { status: "review", summary: "Commit abc1234." } });
    await deliveryNotesInFlight();

    expect(searchedRoots).toEqual(["/worktrees/of/the-card", "/projects/one", "/projects/two"]);
  });
});

describe("a note that died with the process is written at the next boot", () => {
  const findsNothing: RepoProbe = { ...silentProbe, symbolInHistory: () => false };

  test("the agent deliveries still in review without a note are checked again; the others are not", async () => {
    const db = freshDb();
    // The process that delivered never wrote the note (it stopped while git
    // was being asked): modelled by a probe that finds nothing to say.
    const before = createTaskService(db, { repoRootFor: () => "/r", probeFor: () => silentProbe });
    const deliver = (text: string) => {
      const t = before.create({ projectId: PID, text, status: "in_progress" });
      before.update({ taskId: t.id, actor: "agent", by: "agent-1", patch: { status: "review", summary: "Nuovo `neverWrittenSymbol`." } });
      return t.id;
    };
    const lost = deliver("persa");
    const bySystem = deliver("portata dal sistema");
    const old = deliver("vecchia");
    db.run("UPDATE tasks SET delivered_by = 'system' WHERE id = ?", [bySystem]);
    db.run("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [old]);

    const told: string[] = [];
    const next = createTaskService(db, {
      repoRootFor: () => "/r",
      probeFor: () => ({ ...findsNothing, prepare: async () => findsNothing }),
      onLateDeliveryNote: (taskId) => told.push(taskId),
    });
    expect(next.recheckRecentDeliveries(new Date(Date.now() - 60_000).toISOString())).toBe(1);
    await deliveryNotesInFlight();
    const noteOf = (id: string) => next.get(id)!.comments.filter((c) => c.kind === "review-note").map((c) => c.content).join("\n");
    expect(noteOf(lost)).toContain("neverWrittenSymbol");
    expect([noteOf(bySystem), noteOf(old)]).toEqual(["", ""]);
    expect(told).toEqual([lost]);
    // Once written, the note is there: a second boot has nothing left to do.
    expect(next.recheckRecentDeliveries(new Date(Date.now() - 60_000).toISOString())).toBe(0);
  });
});

describe("the verifier's git does not hold the server's loop", () => {
  // A git that answers everything at once except `log -S`, which walks every
  // ref (up to 20 s measured on a real repository): 3 s here, and it finds
  // only `foundSymbolHere`. It stamps the start and end of each `-S` so the
  // fixture can tell whether the loop ran meanwhile.
  function runFixture(mode: "single" | "multirow" | "race") {
    const bin = mkdtempSync(join(tmpdir(), "slow-git-"));
    const marks = mkdtempSync(join(tmpdir(), "slow-git-marks-"));
    writeFileSync(
      join(bin, "git"),
      [
        "#!/bin/sh",
        "sym=",
        `case "$*" in *" -S "*) sym=$(printf '%s\\n' "$*" | sed 's/.* -S \\([^ ]*\\).*/\\1/');; esac`,
        '[ -n "$sym" ] && touch "$MARKS/start-$sym"',
        // A 1 s lookup still proves the claim (the loop beats while git runs,
        // and a synchronous git leaves 0 beats): a 10 ms beat gives tens of
        // beats in 1 s. The 20 s walks of production stay in the comment above.
        'case "$sym" in foundSymbolHere) echo abc1234;; "") ;; *) sleep 1;; esac',
        '[ -n "$sym" ] && touch "$MARKS/end-$sym"',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "git"), 0o755);
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "tasks.delivery-probe.slow-git.fixture.ts"), mkdtempSync(join(tmpdir(), "repo-")), mode],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MARKS: marks }, stdout: "pipe", stderr: "pipe" },
    );
    return (async () => {
      const out = await new Response(child.stdout).text();
      await child.exited;
      return JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { beatsWhileGitRan?: number | null; notes?: string[] };
    })();
  }

  // The three cases use separate dirs and processes, so they run together.
  test.concurrent("one report: the update returns at once, and the note follows git's answer", async () => {
    const r = await runFixture("single");
    expect(r.notes?.join("\n")).toContain("slowSymbolNeverWritten");
    expect(r.beatsWhileGitRan, "the loop stood still while git looked the symbol up").toBeGreaterThan(0);
  }, 30_000);

  test.concurrent("several rows in the turn: git is asked row by row, off the loop, and the note reads only those answers", async () => {
    // The first version asked until the first symbol found across ALL rows, so
    // the older row's symbol was never asked ahead and the check asked it
    // synchronously: 2081 ms of loop held (PR #147, second review).
    const r = await runFixture("multirow");
    expect(r.notes?.join("\n")).toContain("slowSymbolNeverWritten");
    expect(r.beatsWhileGitRan, "the loop stood still while git looked the older row's symbol up").toBeGreaterThan(0);
  }, 30_000);

  test.concurrent("a note still on its way for turn 1 does not land under turn 2's clean delivery", async () => {
    const r = await runFixture("race");
    expect(r.beatsWhileGitRan, "git was asked about turn 1's symbol").not.toBeNull();
    expect(r.notes).toEqual([]);
  }, 30_000);

  test("the probe has no synchronous git left to fall back on", () => {
    // What the three cases above measure, said once where it cannot drift: the
    // only way this module reaches git is `execFile`, answered off the loop.
    const src = readFileSync(join(import.meta.dir, "deliveryReportProbe.ts"), "utf8");
    expect(src.split("\n").filter((l) => /execFileSync|spawnSync|execSync/.test(l))).toEqual([]);
  });

  test("a slow or broken cited repo is unverifiable only for its own report", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "delivery-sha-fault-"));
    const bin = join(scratch, "bin");
    const home = join(scratch, "home");
    const roots = {
      card: join(home, "card"),
      healthy: join(home, "healthy"),
      slow: join(home, "slow"),
      lateSlow: join(home, "late-slow"),
      broken: join(home, "broken"),
    };
    mkdirSync(bin, { recursive: true });
    for (const root of Object.values(roots)) {
      mkdirSync(root, { recursive: true });
      execFileSync("/usr/bin/git", ["init", "-q", "-b", "main"], { cwd: root, env: gitEnv() });
      execFileSync("/usr/bin/git", ["config", "user.name", "Probe fixture"], { cwd: root, env: gitEnv() });
      execFileSync("/usr/bin/git", ["config", "user.email", "probe@example.invalid"], { cwd: root, env: gitEnv() });
      writeFileSync(join(root, "proof.txt"), root);
      execFileSync("/usr/bin/git", ["add", "-A"], { cwd: root, env: gitEnv() });
      execFileSync("/usr/bin/git", ["commit", "-qm", "fixture"], { cwd: root, env: gitEnv() });
    }
    const cardSha = execFileSync("/usr/bin/git", ["-C", roots.card, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const sharedSha = execFileSync("/usr/bin/git", ["-C", roots.healthy, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const replicas = Array.from({ length: 4 }, (_, index) => join(home, `healthy-replica-${index}`));
    for (const root of replicas) {
      execFileSync("/usr/bin/git", ["clone", "-q", "--shared", roots.healthy, root], { env: gitEnv() });
    }
    const shim = join(bin, "git");
    writeFileSync(shim, [
      "#!/usr/bin/python3",
      "import json, os, sys, time",
      "args = sys.argv[1:]",
      "root = args[1] if len(args) > 1 and args[0] == '-C' else os.getcwd()",
      "slow_roots = {os.path.realpath(path) for path in json.loads(os.environ.get('SLOW_GIT_ROOTS', '[]'))}",
      "if root == os.environ.get('BROKEN_GIT_ROOT') and 'rev-parse' in args:",
      "    sys.stderr.write('fatal: injected resolution failure\\n')",
      "    sys.exit(128)",
      "if os.path.realpath(root) in slow_roots and 'cat-file' in args:",
      "    time.sleep(2)",
      "os.execv('/usr/bin/git', ['/usr/bin/git', *args])",
      "",
    ].join("\n"));
    chmodSync(shim, 0o755);
    const reports = [
      `Commit ${sharedSha}. Repo: ${[...replicas.map((root) => join(root, "proof.txt")), join(roots.lateSlow, "proof.txt")].join(" ")}.`,
      `Commit 0000000deadbee1. File cambiato in ${join(roots.slow, "proof.txt")}. Inoltre commit 0000000deadbee4 resta inventato.`,
      `Commit ${cardSha}. File cambiato in ${join(roots.slow, "proof.txt")}.`,
      `Commit 0000000deadbee2. File cambiato in ${join(roots.broken, "proof.txt")}.`,
      "Fatto (commit 0000000deadbee3).",
    ];
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "tasks.delivery-probe.slow-git.fixture.ts"), roots.card, "sha", JSON.stringify(Object.values(roots)), JSON.stringify(reports)],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          BROKEN_GIT_ROOT: roots.broken,
          SLOW_GIT_ROOTS: JSON.stringify([roots.slow, roots.lateSlow]),
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const output = await new Response(child.stdout).text();
      const errors = await new Response(child.stderr).text();
      const exit = await child.exited;
      expect(exit, errors).toBe(0);
      const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
        codes: string[][];
        searches: Array<{ sha: string; exists: boolean; unverifiable: string[] } | null>;
      };
      expect(result.codes, JSON.stringify(result)).toEqual([
        ["sha-unverifiable"],
        ["sha-unverifiable", "sha-missing"],
        ["sha-unverifiable"],
        ["sha-unverifiable"],
        ["sha-missing"],
      ]);
      expect(result.searches[0]?.exists).toBe(true);
      expect(result.searches[0]?.unverifiable?.some((location) => location.endsWith("/home/late-slow"))).toBe(true);
      expect(result.searches[2]?.exists).toBe(true);
      expect(result.searches[2]?.unverifiable?.some((location) => location.endsWith("/home/slow"))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
