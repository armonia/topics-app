import { describe, test, expect } from "bun:test";
import { createTaskAutoMerge, landFallout, worktreeRealDirt, type GitRunResult, type LandSkipCode, type TaskMergeTarget } from "./task-automerge";

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

  test("il branch porta commit di UN'ALTRA sessione → skipped, nessun merge", async () => {
    // Il worktree di una card nasce da `baseRef: "HEAD"`: se il checkout condiviso
    // sta su un branch di lavoro, il branch del task eredita quei commit e il
    // merge li porterebbe su main. Successo davvero (13 commit, 6 altrui).
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "feature/x\n", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") {
        return { code: 0, stdout: "refs/heads/main\nrefs/heads/topics/altra-sessione\nrefs/heads/topics/t1\n", stderr: "" };
      }
      if (key === "rev-list --count") {
        // Con `--not <altri branch>` restano SOLO i commit del task.
        return { code: 0, stdout: args.includes("--not") ? "1\n" : "13\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toContain("13 commit");
      expect(res.reason).toContain("solo 1");
    }
    // Il punto: non deve aver toccato niente.
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
    expect(calls.some((c) => c[0] === "worktree")).toBe(false);
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

  /**
   * Il guasto dell'11/08 (card `2e6964cb`), nella sua forma minima.
   *
   * Il branch è AVANTI rispetto a main, ma togliendo i commit raggiungibili
   * dagli altri rami non ne resta nessuno — succede appena un ramo nasce da un
   * altro, o due card lavorano vicine. Quella risposta vuota veniva letta come
   * «niente da fare», e la card restava in Done col codice fuori da main.
   */
  test("commit propri VUOTI ma branch avanti → skipped 'unisolable', non un merge e non 'nothing'", async () => {
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") {
        return { code: 0, stdout: "refs/heads/main\nrefs/heads/topics/vicina\nrefs/heads/topics/lyrical-cobra\n", stderr: "" };
      }
      // 27 commit avanti, ZERO dopo la sottrazione: la forma esatta del guasto.
      if (key === "rev-list --count") return { code: 0, stdout: args.includes("--not") ? "0\n" : "27\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    if (res.status !== "skipped") throw new Error("expected skipped");
    // Il codice è ciò che la board legge per decidere dove finisce la card.
    expect(res.code).toBe("unisolable");
    // E la frase deve DISTINGUERE le due cose che prima collassavano in una.
    expect(res.reason).toContain("non so quali siano i suoi");
    expect(res.reason).toContain("niente da portare");
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
    expect(calls.some((c) => c[0] === "worktree")).toBe(false);
  });

  test("«non lo so» ≠ «già tutto dentro»: due esiti diversi per due domande diverse", async () => {
    // Il controllo del test qui sopra. Stesso repo, unica differenza: il branch
    // non è avanti. Quella è la consegna già dentro main — `nothing`, e la card
    // resta legittimamente chiusa.
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
      "for-each-ref --format=%(refname)": { stdout: "refs/heads/main\nrefs/heads/topics/vicina\n" },
      "rev-list --count": { stdout: "0\n" },
    });
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: git.run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("nothing");
  });

  test("la sottrazione non risponde (git in errore) → 'unisolable', mai un merge alla cieca", async () => {
    // `null` = non contabile. Prima cadeva nel silenzio e il land proseguiva a
    // mergiare il branch INTERO: cioè, se git singhiozzava, si pubblicava anche
    // il lavoro di un'altra sessione — l'esatto contrario del cancello.
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") {
        return { code: 0, stdout: "refs/heads/main\nrefs/heads/topics/vicina\n", stderr: "" };
      }
      if (key === "rev-list --count") {
        return args.includes("--not")
          ? { code: 128, stdout: "", stderr: "fatal: bad revision" }
          : { code: 0, stdout: "13\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    const res = await am.tryMerge("t1", "x");
    if (res.status !== "skipped") throw new Error(`expected skipped, got ${res.status}`);
    expect(res.code).toBe("unisolable");
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
  });

  test("nemmeno gli ALTRI branch sono elencabili → 'unisolable'", async () => {
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") return { code: 1, stdout: "", stderr: "fatal: not a git repository" };
      if (key === "rev-list --count") return { code: 0, stdout: "3\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    const res = await am.tryMerge("t1", "x");
    if (res.status !== "skipped") throw new Error(`expected skipped, got ${res.status}`);
    expect(res.code).toBe("unisolable");
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
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

/**
 * La regola che chiude il guasto, provata senza un repo e senza una board: dal
 * PERCHÉ il land non è riuscito a DOVE finisce la card.
 */
describe("landFallout — un land fallito non lascia la card in Done", () => {
  test("l'unico esito che lascia la card chiusa è «non c'era niente da atterrare»", () => {
    expect(landFallout("no-branch").status).toBe(null);
  });

  test("ogni altro esito TOGLIE la card da Done, con una ragione da scrivere nello stato", () => {
    const codes: LandSkipCode[] = [
      "unisolable", "foreign-commits", "branch-missing", "dirty-checkout",
      "worktree-add-failed", "internal-error",
    ];
    for (const code of codes) {
      const f = landFallout(code);
      expect(f.status).not.toBe(null);
      // La ragione finisce nella riga di storico: vuota vorrebbe dire di nuovo
      // «lo stato non dice perché», cioè il guasto.
      expect(f.reason.length).toBeGreaterThan(0);
    }
  });

  test("colpa del RAMO → torna all'agente con l'istruzione di rebase; colpa dell'OSPITE → torna all'umano", () => {
    // Il ramo è riparabile dall'agente: stessa strada del conflitto.
    for (const code of ["unisolable", "foreign-commits"] as LandSkipCode[]) {
      const f = landFallout(code);
      expect(f.status).toBe("in_progress");
      expect(f.resume).toContain("git rebase main");
      // Il merge di main dentro il ramo NON toglie il problema: tre card ci
      // sono rimaste incastrate quando l'istruzione lo suggeriva.
      expect(f.resume).not.toContain("git merge main");
    }
    // Albero sporco, worktree non creabile: l'agente non può farci niente.
    for (const code of ["dirty-checkout", "worktree-add-failed", "branch-missing"] as LandSkipCode[]) {
      const f = landFallout(code);
      expect(f.status).toBe("review");
      expect(f.resume).toBeUndefined();
    }
  });

  test("un codice sconosciuto sbaglia verso il RITIRO, mai verso il lasciarla chiusa", () => {
    // Uno `skipped` costruito altrove, o un codice nuovo aggiunto senza passare
    // di qui: il difetto da non ripetere è una card chiusa col codice fuori.
    expect(landFallout(undefined).status).toBe("review");
    expect(landFallout("qualcosa-di-nuovo" as LandSkipCode).status).toBe("review");
  });
});
