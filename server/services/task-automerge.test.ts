/**
 * @covers LAND-04
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { chooseMergeTarget, createTaskAutoMerge, landFallout, normalizePatch, worktreeDirtProbe, worktreeRealDirt, type GitRunResult, type LandSkipCode, type TaskMergeTarget } from "./task-automerge";
import { worktreeRegistrationLost } from "./worktree-registration";

/**
 * THE PROBE HAS THREE ANSWERS, NOT TWO. A folder whose `.git` is a `gitdir:`
 * file pointing into the void is not "a git status that did not answer": it
 * will NEVER answer, and reading it as dirty keeps it forever. The distinction
 * is fixed here without spawning git, and a plain git failure stays generic.
 */
describe("worktreeDirtProbe: registrazione persa", () => {
  test("`.git` file che punta a un gitdir inesistente → unregistered (nessun git spawnato)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-unreg-"));
    try {
      writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "manca", ".git", "worktrees", "x")}\n`);
      expect(worktreeRegistrationLost(dir)).toBe(true);
      const calls: string[][] = [];
      const run = async (_cwd: string, args: string[]): Promise<GitRunResult> => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; };
      expect(await worktreeDirtProbe(dir, run)).toEqual({ ok: false, unregistered: true, paths: [] });
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`.git` file che punta a un gitdir ESISTENTE → e' un checkout, si chiede a git", async () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-reg-"));
    try {
      const gitDirPath = join(dir, "repo", ".git", "worktrees", "x");
      mkdirSync(gitDirPath, { recursive: true });
      mkdirSync(join(dir, "wt"));
      writeFileSync(join(dir, "wt", ".git"), `gitdir: ${gitDirPath}\n`);
      expect(worktreeRegistrationLost(join(dir, "wt"))).toBe(false);
      const clean = async (): Promise<GitRunResult> => ({ code: 0, stdout: "", stderr: "" });
      expect(await worktreeDirtProbe(join(dir, "wt"), clean)).toEqual({ ok: true, paths: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("senza il `.git` file, un git che non risponde resta il generico ok:false: una cartella senza `.git` puo' essere l'unica copia", async () => {
    const notRepo = async (): Promise<GitRunResult> => ({ code: 128, stdout: "", stderr: "fatal: not a git repository\n" });
    expect(await worktreeDirtProbe("/wt-che-non-esiste", notRepo)).toEqual({ ok: false, paths: [] });
    const lock = async (): Promise<GitRunResult> => ({ code: 128, stdout: "", stderr: "fatal: Unable to create '/x/.git/index.lock': File exists.\n" });
    expect(await worktreeDirtProbe("/wt-che-non-esiste", lock)).toEqual({ ok: false, paths: [] });
  });
});

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

  test("foreign commits already on main by content: the branch is not mixed, it is MERGED, not picked", async () => {
    // 05/09/2026: a `pull --rebase` on the shared checkout rewrote the unpushed
    // land merges; every card branch kept the originals, so `mine < total` and
    // the land cherry-picked the own commits onto a moved main and reported a
    // conflict the agent had not written. Ancestry said mixed, content said not.
    const calls: string[][] = [];
    let lastPick = "";
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") {
        return { code: 0, stdout: "refs/heads/main\nrefs/heads/topics/altra\nrefs/heads/topics/t1\n", stderr: "" };
      }
      if (key === "rev-list --count") return { code: 0, stdout: args.includes("--not") ? "1\n" : "3\n", stderr: "" };
      // The probe's lists: every non-merge commit ahead, the own ones, and what
      // main gained since the foreign history left it (one replayed copy).
      if (key === "rev-list --reverse") return { code: 0, stdout: "fff111\nfff222\naaa111\n", stderr: "" };
      if (key === "rev-list --no-merges") return { code: 0, stdout: args.includes("--not") ? "aaa111\n" : "ccc111\n", stderr: "" };
      if (args[0] === "merge-base") return { code: 0, stdout: "base000\n", stderr: "" };
      // fff111's copy on main is ccc111: same diff, other blob ids and line numbers.
      if (key === "show --format=") {
        const sha = args[args.length - 1];
        if (sha === "ccc111") return { code: 0, stdout: "diff --git a/x b/x\nindex 1111..2222 100644\n@@ -10,2 +10,3 @@\n+riga\n", stderr: "" };
        if (sha === "fff111") return { code: 0, stdout: "diff --git a/x b/x\nindex 3333..4444 100644\n@@ -4,2 +4,3 @@\n+riga\n", stderr: "" };
        return { code: 0, stdout: `diff --git a/${sha} b/${sha}\n+${sha}\n`, stderr: "" };
      }
      if (args[0] === "cherry-pick" && args[1] === "-n") { lastPick = args[args.length - 1]!; return { code: 0, stdout: "", stderr: "" }; }
      // Nothing staged for the foreign commit the patch did not match: its content is on main too.
      if (key === "diff --cached") return { code: 0, stdout: "", stderr: "" };
      if (key === "merge --no-ff") return { code: 0, stdout: "", stderr: "" };
      if (key === "rev-parse --short") return { code: 0, stdout: "abc1234\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    // fff111 was recognised by its patch (no pick), fff222 by its stage (one pick);
    // the own commit was never picked, the branch was merged.
    expect(calls.filter((c) => c[0] === "cherry-pick" && c[1] === "-n").map((c) => c[c.length - 1])).toEqual(["fff222"]);
    expect(lastPick).toBe("fff222");
    expect(calls.some((c) => c[0] === "merge" && c.includes("--no-ff"))).toBe(true);
    expect(calls.some((c) => c[0] === "commit" && c.includes("-C"))).toBe(false);
    // And the probe left the checkout as it found it after the pick.
    expect(calls.filter((c) => c[0] === "reset" && c.includes("--hard")).length).toBe(1);
  });

  test("a foreign commit that DOES bring content keeps the selective pick", async () => {
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") {
        return { code: 0, stdout: "refs/heads/main\nrefs/heads/topics/altra\nrefs/heads/topics/t1\n", stderr: "" };
      }
      if (key === "rev-list --count") return { code: 0, stdout: args.includes("--not") ? "1\n" : "3\n", stderr: "" };
      // The probe (no --not) lists all; the selective pick (with --not) lists the own one.
      if (key === "rev-list --reverse") return { code: 0, stdout: args.includes("--not") ? "aaa111\n" : "fff111\nfff222\naaa111\n", stderr: "" };
      if (key === "rev-list --no-merges") return { code: 0, stdout: args.includes("--not") ? "aaa111\n" : "", stderr: "" };
      if (key === "show --format=") return { code: 0, stdout: `diff --git a/${args[args.length - 1]} b/x\n+x\n`, stderr: "" };
      if (args[0] === "cherry-pick" && args[1] === "-n") return { code: 0, stdout: "", stderr: "" };
      // fff111 stages something: main lacks it, the branch IS mixed.
      if (key === "diff --cached") return { code: 1, stdout: "", stderr: "" };
      if (key === "rev-parse --short") return { code: 0, stdout: "abc1234\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("merged");
    // The probe stopped at the first foreign commit that brought content...
    expect(calls.filter((c) => c[0] === "cherry-pick" && c[1] === "-n").map((c) => c[c.length - 1])).toEqual(["fff111", "aaa111"]);
    // ...and the own commit was picked and committed, the branch never merged.
    expect(calls.some((c) => c[0] === "commit" && c.includes("-C") && c.includes("aaa111"))).toBe(true);
    expect(calls.some((c) => c[0] === "merge")).toBe(false);
  });

  test("normalizePatch: blob ids and hunk line numbers do not count, the change does", () => {
    const a = "diff --git a/x b/x\nindex 1111..2222 100644\n--- a/x\n+++ b/x\n@@ -10,2 +10,3 @@\n ctx\n+riga\n";
    const b = "diff --git a/x b/x\nindex 3333..4444 100644\n--- a/x\n+++ b/x\n@@ -4,2 +4,3 @@\n ctx\n+riga\n";
    const c = "diff --git a/x b/x\nindex 3333..4444 100644\n--- a/x\n+++ b/x\n@@ -4,2 +4,3 @@\n ctx\n+altra riga\n";
    expect(normalizePatch(a)).toBe(normalizePatch(b));
    expect(normalizePatch(a)).not.toBe(normalizePatch(c));
    expect(normalizePatch("")).toBeNull();
    // A generated baseline's section does not count: 147a805ce and its copy on
    // main differed only there (05/09/2026), and they are the same change.
    const baseline = "diff --git a/scripts/identifier-language-baseline.json b/scripts/identifier-language-baseline.json\nindex 5..6 100644\n--- a/scripts/identifier-language-baseline.json\n+++ b/scripts/identifier-language-baseline.json\n@@ -1,2 +1,2 @@\n-  \"generated\": \"2026-09-04\",\n+  \"generated\": \"2026-09-05\",\n";
    expect(normalizePatch(a + baseline)).toBe(normalizePatch(b));
    expect(normalizePatch(baseline)).toBeNull();
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

  test("il pick fallisce perché MANCA un pezzo sotto: si dice quello, non «conflitto»", async () => {
    // Il worktree della card nasce dall'HEAD del checkout condiviso, quindi il
    // suo lavoro può poggiare su commit di un'altra sessione — che il pick
    // selettivo esclude apposta, per non pubblicarli. Il pick allora fallisce su
    // un file che su main non esiste ancora: non c'è niente da riconciliare, e
    // rimandarlo all'agente come «conflitto» lo manda a cercare una cosa che non
    // c'è. Misurato il 10/08 su 473da2db (02fd8bac modifica browserPaneFault.ts,
    // creato da un commit di un'altra sessione mai landato).
    const run = async (_cwd: string, args: string[]) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "feature/x\n", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") {
        return { code: 0, stdout: "refs/heads/main\nrefs/heads/topics/altra\nrefs/heads/topics/t1\n", stderr: "" };
      }
      if (key === "rev-list --count") return { code: 0, stdout: args.includes("--not") ? "2\n" : "9\n", stderr: "" };
      if (key === "rev-list --reverse") return { code: 0, stdout: "aaa111\nbbb222\n", stderr: "" };
      if (args[0] === "cherry-pick" && args[1] === "-n") return { code: 1, stdout: "", stderr: "CONFLICT (modify/delete): browserPaneFault.ts deleted in HEAD" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    // 9 sul branch, 2 suoi → 7 sotto di lui che non sono su main.
    if (res.status === "skipped") {
      expect(res.reason).toContain("7 commit");
      expect(res.reason).toContain("manca un pezzo sotto");
    }
  });

  test("pick fallito SENZA dipendenze estranee resta un conflitto vero", async () => {
    // Il controllo del test qui sopra: la diagnosi nuova non deve mangiarsi il
    // caso normale, o un conflitto vero non tornerebbe più all'agente.
    const run = async (_cwd: string, args: string[]) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "feature/x\n", stderr: "" };
      if (key === "for-each-ref --format=%(refname)") {
        return { code: 0, stdout: "refs/heads/main\nrefs/heads/topics/altra\nrefs/heads/topics/t1\n", stderr: "" };
      }
      if (key === "rev-list --count") return { code: 0, stdout: args.includes("--not") ? "2\n" : "9\n", stderr: "" };
      if (key === "rev-list --reverse") return { code: 0, stdout: "aaa111\nbbb222\n", stderr: "" };
      // Stessi 7 commit estranei del test sopra, ma il fallimento e' di
      // CONTENUTO: due modifiche che si pestano, non un file che manca.
      if (args[0] === "cherry-pick" && args[1] === "-n") {
        return { code: 1, stdout: "", stderr: "CONFLICT (content): Merge conflict in src/a.ts" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    expect((await am.tryMerge("t1", "x")).status).toBe("conflict");
  });

  test("due migration con lo STESSO numero: il land si ferma prima di rompere il DB in silenzio", async () => {
    // `schema_migrations.version` e' chiave primaria intera e il runner fa
    // `if (applied.has(version)) continue`: salta per NUMERO, senza dire niente.
    // La seconda 089 non si applicherebbe MAI, mentre il codice che la presuppone
    // atterra lo stesso — guasto invisibile al land, visibile in produzione.
    // Misurato il 10/08: DUE collisioni in una sera, con N card in parallelo.
    const calls: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      calls.push(args);
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key === "rev-list --count") return { code: 0, stdout: "3\n", stderr: "" };
      if (key === "ls-tree -r") {
        const ref = args[3];
        return ref === "main"
          ? { code: 0, stdout: "server/db/migrations/089-retirements.sql\n", stderr: "" }
          : { code: 0, stdout: "server/db/migrations/089-task-dispatch-weight.sql\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toContain("089");
      expect(res.reason).toContain("Rinumera");
    }
    // E si ferma PRIMA di toccare main.
    expect(calls.some((c) => c[0] === "merge" || c[0] === "cherry-pick")).toBe(false);
  });

  test("stesso numero, stesso file: e' lo storico condiviso, non una collisione", async () => {
    // Il controllo del test qui sopra: un ramo che eredita le migration di main
    // senza aggiungerne deve passare, o il cancello bloccherebbe ogni land.
    const run = async (_cwd: string, args: string[]) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key === "rev-list --count") return { code: 0, stdout: "3\n", stderr: "" };
      if (key === "ls-tree -r") return { code: 0, stdout: "server/db/migrations/089-retirements.sql\n", stderr: "" };
      if (key === "merge --no-ff") return { code: 0, stdout: "", stderr: "" };
      if (key === "rev-parse --short") return { code: 0, stdout: "abc1234\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    expect((await am.tryMerge("t1", "x")).status).toBe("merged");
  });

  test("due timestamp DIVERSI non sono una collisione: il numero e' tutto il prefisso", async () => {
    // Il difetto che chiude, misurato il 12/08 su `ddf66270` e `b06bb837`: il
    // numero si leggeva con `file.slice(0, 3)`, e col prefisso timestamp
    // introdotto lo stesso giorno OGNI migration del 2026 finiva sotto la chiave
    // `202`. Bastava che main e il ramo avessero migration diverse — cioe' il
    // caso NORMALE di un ramo in review mentre main va avanti — perche' il
    // cancello gridasse collisione. Diciotto consegne sono rimaste fuori da main
    // per questo, e il messaggio accusava un file che era gia' atterrato.
    const run = async (_cwd: string, args: string[]) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key === "rev-list --count") return { code: 0, stdout: "3\n", stderr: "" };
      if (key === "ls-tree -r") {
        const ref = args[3];
        // main ha una migration in piu' del ramo: e' la vita normale di una card
        // che aspetta la review.
        return ref === "main"
          ? {
              code: 0,
              stdout:
                "server/db/migrations/20260812094300-notification-log.sql\n" +
                "server/db/migrations/20260812120000-preview-retired.sql\n",
              stderr: "",
            }
          : { code: 0, stdout: "server/db/migrations/20260812094300-notification-log.sql\n", stderr: "" };
      }
      if (key === "merge --no-ff") return { code: 0, stdout: "", stderr: "" };
      if (key === "rev-parse --short") return { code: 0, stdout: "abc1234\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    expect((await am.tryMerge("t1", "x")).status).toBe("merged");
  });

  test("due timestamp UGUALI con nomi diversi NON sono una collisione: il registro conta i nomi", async () => {
    // Scritto al contrario la prima volta, il 12/08, e vale la pena dire perche':
    // sembra ovvio che due file con lo stesso numero siano un guasto. Lo erano
    // finche' `schema_migrations` aveva `version` come chiave primaria e il
    // runner saltava per NUMERO. Oggi la chiave e' il NOME
    // (`server/db.ts`: `name TEXT PRIMARY KEY`, e il salto e' `applied.has(file)`),
    // quindi due migration nate nello stesso SECONDO in due worktree che non si
    // vedevano si applicano ENTRAMBE: nessuna delle due dipende dall'altra, e non
    // c'e' nessun ordine atteso da rompere.
    //
    // Il contatore a tre cifre resta un guasto, ed e' il test qui sopra: li' il
    // numero uno se lo SCEGLIE credendolo libero, quindi due nomi sullo stesso
    // numero vogliono dire che qualcuno contava su un ordine che e' gia' saltato.
    const run = async (_cwd: string, args: string[]) => {
      const key = args.slice(0, 2).join(" ");
      if (key === "symbolic-ref --short") return { code: 0, stdout: "main\n", stderr: "" };
      if (key === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (key === "rev-list --count") return { code: 0, stdout: "3\n", stderr: "" };
      if (key === "ls-tree -r") {
        const ref = args[3];
        return ref === "main"
          ? { code: 0, stdout: "server/db/migrations/20260812094300-notification-log.sql\n", stderr: "" }
          : { code: 0, stdout: "server/db/migrations/20260812094300-altra-cosa.sql\n", stderr: "" };
      }
      if (key === "merge --no-ff") return { code: 0, stdout: "", stderr: "" };
      if (key === "rev-parse --short") return { code: 0, stdout: "abc1234\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run });
    expect((await am.tryMerge("t1", "x")).status).toBe("merged");
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
    // The bundle check is stubbed out: this test is about the queue, and the
    // real one would look at a `public/` that no fake repo has (see
    // task-automerge-build-artifact.test.ts for the check itself).
    const am = createTaskAutoMerge({ resolveTaskMerge: () => TARGET, runGit: run, runBuild, verifyBundle: () => null });
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
      "unisolable", "foreign-commits", "branch-missing", "repo-unresolved",
      "dirty-checkout", "worktree-add-failed", "internal-error",
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
    // Albero sporco, worktree non creabile, checkout introvabile: l'agente non
    // può farci niente.
    for (const code of ["dirty-checkout", "worktree-add-failed", "branch-missing", "repo-unresolved"] as LandSkipCode[]) {
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

/**
 * L'agente è UN MODO di trovare il ramo, non l'unico.
 *
 * Misurato la notte del 12/08 su `ee5ebbb4`: `delivery_branch` esisteva
 * (`topics/transient-berry`, 7fd16448), il suo worktree esisteva, mancava solo
 * `assigned_topic_id` — l'agente rilasciato a fine turno. Il land ha risposto
 * «nessun worktree/branch per il task (in-place o non dispatchato)», codice
 * `no-branch`, e la card è rimasta in Done col codice fuori da main.
 */
describe("chooseMergeTarget — il ramo si trova dalla CARD, non solo dall'agente", () => {
  const LIVE: TaskMergeTarget = { repoPath: "/repo", branch: "topics/lyrical-cobra", defaultBranch: "main" };

  test("il worktree vivo vince quando c'è", () => {
    const c = chooseMergeTarget(LIVE, { repoPath: "/repo", branch: "topics/altro" });
    expect(c.target).toEqual(LIVE);
    if (c.target) expect(c.via).toBe("worktree");
  });

  test("agente rilasciato ma ramo dichiarato → si atterra lo stesso, via consegna", () => {
    const c = chooseMergeTarget(null, { repoPath: "/repo", branch: "topics/transient-berry" });
    expect(c.target).toEqual({ repoPath: "/repo", branch: "topics/transient-berry", defaultBranch: "main" });
    if (c.target) expect(c.via).toBe("delivery");
  });

  test("ramo dichiarato ma checkout introvabile → NON è «no-branch»: la card lascia Done", () => {
    const c = chooseMergeTarget(null, { repoPath: null, branch: "topics/transient-berry" });
    expect(c.target).toBe(null);
    if (c.target === null) {
      expect(c.code).toBe("repo-unresolved");
      // Il messaggio deve dire cosa manca DAVVERO: il ramo c'è, il checkout no.
      expect(c.reason).toContain("topics/transient-berry");
      expect(landFallout(c.code).status).toBe("review");
    }
  });

  test("né worktree né ramo dichiarato → «no-branch», l'unico caso che resta chiuso", () => {
    for (const declared of [null, undefined, { repoPath: "/repo", branch: null }, { repoPath: "/repo", branch: "  " }]) {
      const c = chooseMergeTarget(null, declared);
      expect(c.target).toBe(null);
      if (c.target === null) expect(c.code).toBe("no-branch");
    }
  });
});

describe("tryMerge senza agente — la consegna col ramo intatto resta landabile", () => {
  const DECLARED = { repoPath: "/repo", branch: "topics/transient-berry" };

  test("assigned_topic_id NULL + delivery_branch valido → merged", async () => {
    const git = fakeGit({
      ...CLEAN_PRECONDITIONS,
      "merge --no-ff": { code: 0 },
      "rev-parse --short": { stdout: "abc1234\n" },
    });
    const am = createTaskAutoMerge({
      resolveTaskMerge: () => null,          // l'agente non c'è più
      declaredDelivery: () => DECLARED,      // ma la card il ramo lo dichiara
      runGit: git.run,
    });
    const res = await am.tryMerge("t1", "Land in raffica", { branch: DECLARED.branch, commit: null });
    expect(res.status).toBe("merged");
    if (res.status === "merged") {
      expect(res.branch).toBe(DECLARED.branch);
      expect(res.repoPath).toBe("/repo");
      // Ramo vivo e ramo consegnato coincidono: niente da segnalare al reviewer.
      expect(res.deliveryDrift).toBe(null);
    }
  });

  test("ramo dichiarato che nel repo non esiste più → 'branch-missing', non 'no-branch'", async () => {
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count": { code: 128, stderr: "fatal: unknown revision" },
    });
    const am = createTaskAutoMerge({
      resolveTaskMerge: () => null,
      declaredDelivery: () => DECLARED,
      runGit: git.run,
    });
    const res = await am.tryMerge("t1", "x", { branch: DECLARED.branch, commit: null });
    expect(res.status).toBe("skipped");
    // Il land davvero impossibile NON lascia la card in Done.
    if (res.status === "skipped") expect(landFallout(res.code).status).toBe("review");
  });

  test("ramo POTATO ma commit dentro main: e' atterrato, non e' un land fallito", async () => {
    // Il difetto, misurato il 12/08 su `d0777424`: dopo un land riuscito il ramo
    // viene potato. Da quel momento chiudere la card faceva ripartire un land
    // che non trovava piu' il ramo, rispondeva `branch-missing` e la rimandava in
    // review. La card non si poteva chiudere, e restava li' a sembrare una
    // decisione da prendere. Il commit sopravvive al ramo ed e' la prova.
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count": { code: 128, stderr: "fatal: unknown revision" },
      "merge-base --is-ancestor": { code: 0, stdout: "" },
    });
    const am = createTaskAutoMerge({
      resolveTaskMerge: () => null,
      declaredDelivery: () => DECLARED,
      runGit: git.run,
    });
    const res = await am.tryMerge("t1", "x", { branch: DECLARED.branch, commit: "c2d20879aaaabbbbccccddddeeeeffff00001111" });
    expect(res.status).toBe("nothing");
  });

  test("ramo potato e NESSUN commit di consegna: il merge del land basta da solo", async () => {
    // Il difetto che questo chiude, misurato il 18/08 su `171b787d`: la prova
    // per commit del test qui sopra pretende `delivery.commit`, e quella colonna
    // restava vuota su 9 card su 10. Senza sha la domanda non si faceva: si
    // cadeva su `branch-missing`, e la card veniva RIAPERTA — due volte, ogni
    // volta che qualcuno la chiudeva — mentre il merge `a89990ecb` era su main
    // da giorni.
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count": { code: 128, stderr: "fatal: unknown revision" },
      // Il merge del land, che porta il nome della card e sopravvive al ramo.
      log: { stdout: "a89990ecb1111222233334444555566667777888\n" },
    });
    const am = createTaskAutoMerge({
      resolveTaskMerge: () => null,
      declaredDelivery: () => DECLARED,
      runGit: git.run,
    });
    const res = await am.tryMerge("t1", "x", { branch: DECLARED.branch, commit: null });
    expect(res.status).toBe("nothing");
    // E la domanda deve essere quella giusta: solo i MERGE, e per nome della
    // card. Senza `--merges` un commit qualunque che citi l'id passerebbe per un
    // atterraggio.
    const log = git.calls.find((a) => a[0] === "log");
    expect(log).toBeDefined();
    expect(log).toContain("--merges");
    expect(log).toContain("--grep=merge task t1");
  });

  test("ramo potato, nessun commit e NESSUN merge: resta un land fallito", async () => {
    // Il rovescio del caso qui sopra. La seconda prova non deve diventare
    // «chiudi comunque»: senza merge e senza commit non sappiamo niente, e
    // l'unica risposta sicura è rimandare la card indietro.
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count": { code: 128, stderr: "fatal: unknown revision" },
      log: { stdout: "" },
    });
    const am = createTaskAutoMerge({
      resolveTaskMerge: () => null,
      declaredDelivery: () => DECLARED,
      runGit: git.run,
    });
    const res = await am.tryMerge("t1", "x", { branch: DECLARED.branch, commit: null });
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") expect(res.code).toBe("branch-missing");
  });

  test("ramo potato e commit NON su main: resta un land fallito", async () => {
    // Il controllo del test qui sopra: la prova per commit non deve diventare
    // «chiudi comunque». Se il contenuto non e' su main, il lavoro e' davvero
    // fuori e la card deve tornare indietro.
    const git = fakeGit({
      "symbolic-ref --short": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
      "rev-list --count": { code: 128, stderr: "fatal: unknown revision" },
      "merge-base --is-ancestor": { code: 1, stdout: "" },
    });
    const am = createTaskAutoMerge({
      resolveTaskMerge: () => null,
      declaredDelivery: () => DECLARED,
      runGit: git.run,
    });
    const res = await am.tryMerge("t1", "x", { branch: DECLARED.branch, commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") expect(res.code).toBe("branch-missing");
  });

  test("niente agente e niente ramo → resta «no-branch», e il messaggio non parla più di worktree inesistenti", async () => {
    const git = fakeGit({});
    const am = createTaskAutoMerge({
      resolveTaskMerge: () => null,
      declaredDelivery: () => ({ repoPath: "/repo", branch: null }),
      runGit: git.run,
    });
    const res = await am.tryMerge("t1", "x");
    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.code).toBe("no-branch");
      expect(landFallout(res.code).status).toBe(null);
    }
    expect(git.calls.length).toBe(0);
  });
});
