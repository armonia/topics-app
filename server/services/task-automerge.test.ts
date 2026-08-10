import { describe, test, expect } from "bun:test";
import { createTaskAutoMerge, worktreeRealDirt, type GitRunResult, type TaskMergeTarget } from "./task-automerge";

const TARGET: TaskMergeTarget = { repoPath: "/repo", branch: "topics/lyrical-cobra", defaultBranch: "main" };

/** Build a fake git runner from per-subcommand canned responses; records calls. */
function fakeGit(responses: Record<string, Partial<GitRunResult>>) {
  const calls: string[][] = [];
  const run = async (_cwd: string, args: string[]): Promise<GitRunResult> => {
    calls.push(args);
    // Key on the first two tokens (e.g. "merge --abort" vs "merge --no-ff").
    const key = args.slice(0, 2).join(" ");
    const r = responses[key] ?? responses[args[0]] ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

const CLEAN_PRECONDITIONS = {
  "symbolic-ref --short": { stdout: "main\n" },
  "status --porcelain": { stdout: "" },
  "rev-list --count": { stdout: "3\n" },
};

describe("task-automerge", () => {
  test("clean merge → 'merged', invoked with --no-ff", async () => {
    const git = fakeGit({
      ...CLEAN_PRECONDITIONS,
      "merge --no-ff": { code: 0 },
      "rev-parse --short": { stdout: "abc1234\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "Titolo task");
    expect(res.status).toBe("merged");
    if (res.status === "merged") { expect(res.commit).toBe("abc1234"); expect(res.branch).toBe(TARGET.branch); }
    expect(git.calls.some((c) => c[0] === "merge" && c.includes("--no-ff"))).toBe(true);
  });

  test("merge conflict → 'conflict' and 'merge --abort' is called", async () => {
    const git = fakeGit({
      ...CLEAN_PRECONDITIONS,
      "merge --no-ff": { code: 1, stderr: "CONFLICT" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("conflict");
    expect(git.calls.some((c) => c[0] === "merge" && c.includes("--abort"))).toBe(true);
  });

  test("on main but dirty working tree → 'skipped', never merges", async () => {
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "rev-list --count": { stdout: "3\n" },
      "status --porcelain": { stdout: " M src/foo.ts\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    expect(git.calls.some((c) => c[0] === "merge")).toBe(false);
  });

  test("shared checkout on a dev branch → lands via a throwaway main worktree, landedNotLive", async () => {
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "feature/x\n" },
      "rev-list --count": { stdout: "3\n" },
      "worktree add": { code: 0 },
      "merge --no-ff": { code: 0 },
      "rev-parse --short": { stdout: "abc1234\n" },
      "diff --name-only": { stdout: "server/foo.ts\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    if (res.status === "merged") {
      expect(res.landedNotLive).toBe(true);
      expect(res.checkoutBranch).toBe("feature/x");
      expect(res.touchedServer).toBe(true);
    }
    // The shared checkout is NEVER merged into; the throwaway worktree is added then removed.
    expect(git.calls.some((c) => c[0] === "worktree" && c[1] === "add")).toBe(true);
    expect(git.calls.some((c) => c[0] === "worktree" && c[1] === "remove")).toBe(true);
  });

  test("il branch porta commit di UN'ALTRA sessione → landa SOLO i suoi, senza mergiare il branch", async () => {
    // La prima versione si rifiutava e basta: main restava pulito e la consegna
    // finiva in un limbo. Misurato: 12 consegne accettate vivevano solo sul loro
    // branch, fra cui uno scorporo da 800 righe. «Accettata» deve voler dire
    // «atterrata», quindi si prendono i suoi commit e si lascia il resto.
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "feature/x\n", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") {
        return { code: 0, stdout: "refs/heads/main\nrefs/heads/topics/altra-sessione\nrefs/heads/topics/t1\n", stderr: "" };
      }
      if (key === "rev-list --count") return { code: 0, stdout: args.includes("--not") ? "1\n" : "13\n", stderr: "" };
      if (key === "rev-list --reverse") return { code: 0, stdout: "aaa111\n", stderr: "" };
      // Codice 1 = c'e' roba in stage, cioe' quel commit porta davvero qualcosa.
      // Senza questa riga il pick verrebbe saltato come «gia' applicato» e il
      // test passerebbe per il motivo sbagliato.
      if (key === "diff --cached") return { code: 1, stdout: "", stderr: "" };
      if (key === "rev-parse --short") return { code: 0, stdout: "abc1234\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    // Il suo commit e' stato raccolto e COMMITTATO; il branch NON e' stato mergiato.
    expect(calls.some((c) => c[0] === "cherry-pick" && c.includes("aaa111"))).toBe(true);
    expect(calls.some((c) => c[0] === "commit" && c.includes("-C") && c.includes("aaa111"))).toBe(true);
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
  });

  test("un commit che non porta NIENTE in stage è già landato: si salta, niente commit vuoto", async () => {
    // Il land RICOPIA invece di fondere, quindi la copia atterrata ha un altro
    // sha e il commit resta nel range: rilandare la stessa card lasciava un
    // commit VUOTO su main. Misurato il 10/08: lo stesso lavoro QUATTRO volte.
    // Ne' il patch-id (`git cherry`) ne' la patch a rovescio lo riconoscono —
    // il pick adatta il commit, e appena altri toccano quei file il contorno non
    // combacia piu'. Solo il merge di git sa rispondere: applica e guarda se
    // resta qualcosa.
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "feature/x\n", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") {
        return { code: 0, stdout: "refs/heads/main\nrefs/heads/topics/altra\nrefs/heads/topics/t1\n", stderr: "" };
      }
      if (key === "rev-list --count") return { code: 0, stdout: args.includes("--not") ? "1\n" : "13\n", stderr: "" };
      if (key === "rev-list --reverse") return { code: 0, stdout: "aaa111\n", stderr: "" };
      if (key === "diff --cached") return { code: 0, stdout: "", stderr: "" }; // niente da portare
      if (key === "rev-parse --short") return { code: 0, stdout: "abc1234\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    // Il lavoro E' su main: consegna riuscita, non un fallimento da rimandare.
    expect((await am.tryMerge("t1", "x")).status).toBe("merged");
    expect(calls.some((c) => c[0] === "commit")).toBe(false);
    // E l'albero non resta a metà: il pick a vuoto viene ripulito.
    expect(calls.some((c) => c[0] === "cherry-pick" && c.includes("--quit"))).toBe(true);
  });

  test("un branch che non porta NIENTE di suo resta rifiutato", async () => {
    // Il controllo del test qui sopra: raccogliere i propri commit non deve
    // diventare «landa comunque». Zero commit suoi = niente da landare.
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "feature/x\n", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") {
        return { code: 0, stdout: "refs/heads/main\nrefs/heads/topics/altra\nrefs/heads/topics/t1\n", stderr: "" };
      }
      if (key === "rev-list --count") return { code: 0, stdout: args.includes("--not") ? "0\n" : "13\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") expect(res.reason).toContain("NESSUNO");
    expect(calls.some((c) => c[0] === "cherry-pick" || c[0] === "merge")).toBe(false);
  });

  test("il branch porta SOLO i suoi commit → il cancello lascia passare", async () => {
    // Il controllo del test qui sopra: se il cancello scattasse sempre, questo
    // fallirebbe. Stessa forma, ma nessun commit ereditato.
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") {
        return { code: 0, stdout: "refs/heads/main\nrefs/heads/topics/altra-sessione\nrefs/heads/topics/t1\n", stderr: "" };
      }
      if (key === "rev-list --count") return { code: 0, stdout: "3\n", stderr: "" }; // own === total
      if (key === "rev-parse --short") return { code: 0, stdout: "abc1234\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    expect(calls.some((c) => c[0] === "merge")).toBe(true);
  });

  test("in-place land on main reports landedNotLive false", async () => {
    const git = fakeGit({
      ...CLEAN_PRECONDITIONS,
      "merge --no-ff": { code: 0 },
      "rev-parse --short": { stdout: "abc1234\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    if (res.status !== "merged") throw new Error(`expected merged, got ${res.status}`);
    expect(res.landedNotLive).toBe(false);
    expect(res.checkoutBranch).toBe("main");
    expect(git.calls.some((c) => c[0] === "worktree")).toBe(false);
  });

  test("worktree land conflict → 'conflict', aborts, still removes the worktree", async () => {
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "feature/x\n" },
      "rev-list --count": { stdout: "3\n" },
      "worktree add": { code: 0 },
      "merge --no-ff": { code: 1, stderr: "CONFLICT" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("conflict");
    expect(git.calls.some((c) => c[0] === "merge" && c.includes("--abort"))).toBe(true);
    expect(git.calls.some((c) => c[0] === "worktree" && c[1] === "remove")).toBe(true);
  });

  test("worktree add fails → 'skipped' (never merges)", async () => {
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "feature/x\n" },
      "rev-list --count": { stdout: "3\n" },
      "worktree add": { code: 1, stderr: "fatal: 'main' is already checked out" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    expect(git.calls.some((c) => c[0] === "merge" && c.includes("--no-ff"))).toBe(false);
  });

  test("no commits ahead of main → 'nothing'", async () => {
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count": { stdout: "0\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("nothing");
    expect(git.calls.some((c) => c[0] === "merge")).toBe(false);
  });

  test("branch missing (rev-list fails) → 'skipped'", async () => {
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count": { code: 128, stderr: "unknown revision" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
  });

  test("no worktree/branch (resolve → null) → 'skipped'", async () => {
    const git = fakeGit({});
    const am = createTaskAutoMerge({ resolveTaskMerge: () => null, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    expect(git.calls.length).toBe(0);
  });

  test("merged landing that touches client/ → touchedClient true + repoPath", async () => {
    const git = fakeGit({
      ...CLEAN_PRECONDITIONS,
      "merge --no-ff": { code: 0 },
      "rev-parse --short": { stdout: "abc1234\n" },
      "diff --name-only": { stdout: "client/src/App.tsx\nserver/foo.ts\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    if (res.status === "merged") {
      expect(res.touchedClient).toBe(true);
      expect(res.repoPath).toBe(TARGET.repoPath);
    }
  });

  test("merged landing flags per area: server.ts root file and desktop-tauri/", async () => {
    const git = fakeGit({
      ...CLEAN_PRECONDITIONS,
      "merge --no-ff": { code: 0 },
      "rev-parse --short": { stdout: "abc1234\n" },
      "diff --name-only": { stdout: "server.ts\ndesktop-tauri/src-tauri/src/lib.rs\nREADME.md\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    if (res.status !== "merged") throw new Error(`expected merged, got ${res.status}`);
    expect(res.touchedServer).toBe(true);
    expect(res.touchedNative).toBe(true);
    expect(res.touchedClient).toBe(false);
    // "serverless" name must not fool the prefix check.
    const git2 = fakeGit({
      ...CLEAN_PRECONDITIONS,
      "merge --no-ff": { code: 0 },
      "rev-parse --short": { stdout: "abc1234\n" },
      "diff --name-only": { stdout: "serverless.md\nclient/src/App.tsx\n" },
    });
    const am2 = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git2.run });
    const res2 = await am2.tryMerge("t1", "x");
    if (res2.status !== "merged") throw new Error("expected merged");
    expect(res2.touchedServer).toBe(false);
    expect(res2.touchedClient).toBe(true);
  });

  test("worktreeRealDirt: junk excluded, tracked+real untracked counted, rename/quoted parsed", async () => {
    const run = async (_cwd: string, _args: string[]): Promise<GitRunResult> => ({
      code: 0,
      stdout: [
        " M desktop-tauri/src-tauri/src/lib.rs",
        "?? .topics-daemon/daemon-process.lock",
        "?? graphify-out/graph.json",
        "?? .claude-task-summary.md",
        '?? "file with spaces.txt"',
      ].join("\n") + "\n",
      stderr: "",
    });
    expect(await worktreeRealDirt("/wt", run)).toEqual([
      "desktop-tauri/src-tauri/src/lib.rs",
      "file with spaces.txt",
    ]);
    // status failure → empty (the gate must never hard-fail on a git hiccup)
    const boom = async (): Promise<GitRunResult> => ({ code: 128, stdout: "", stderr: "not a repo" });
    expect(await worktreeRealDirt("/wt", boom)).toEqual([]);
    // fully committed worktree → empty
    const clean = async (): Promise<GitRunResult> => ({ code: 0, stdout: "", stderr: "" });
    expect(await worktreeRealDirt("/wt", clean)).toEqual([]);
  });

  test("merged landing that only touches server/ → touchedClient false", async () => {
    const git = fakeGit({
      ...CLEAN_PRECONDITIONS,
      "merge --no-ff": { code: 0 },
      "rev-parse --short": { stdout: "abc1234\n" },
      "diff --name-only": { stdout: "server/foo.ts\nREADME.md\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    if (res.status === "merged") expect(res.touchedClient).toBe(false);
    else throw new Error(`expected merged, got ${res.status}`);
  });

  test("buildClient rides the same per-repo queue as merges", async () => {
    let active = 0;
    let maxActive = 0;
    const enter = async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    const run = async (_cwd: string, args: string[]): Promise<GitRunResult> => {
      await enter();
      if (args.slice(0, 2).join(" ") === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (args.slice(0, 2).join(" ") === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (args.slice(0, 2).join(" ") === "rev-list --count") return { code: 0, stdout: "0\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const runBuild = async (_cwd: string): Promise<GitRunResult> => {
      await enter();
      return { code: 0, stdout: "built", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run, runBuild });
    const [, , build] = await Promise.all([
      am.tryMerge("a", "x"),
      am.tryMerge("b", "y"),
      am.buildClient(TARGET.repoPath),
    ]);
    expect(maxActive).toBe(1);
    expect(build.code).toBe(0);
  });

  test("serializes per repo path (no overlapping git ops on the same repo)", async () => {
    let active = 0;
    let maxActive = 0;
    const run = async (_cwd: string, args: string[]): Promise<GitRunResult> => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (args.slice(0, 2).join(" ") === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (args.slice(0, 2).join(" ") === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (args.slice(0, 2).join(" ") === "rev-list --count") return { code: 0, stdout: "0\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    await Promise.all([am.tryMerge("a", "x"), am.tryMerge("b", "y"), am.tryMerge("c", "z")]);
    expect(maxActive).toBe(1);
  });
});
