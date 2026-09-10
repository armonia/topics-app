/**
 * La riga che conta è quella ORFANA: un ramo senza task è quello che nessuno
 * reclamerà, e se l'abbinamento lo nasconde dentro un task sbagliato l'elenco
 * smette di servire proprio nel caso per cui esiste.
 *
 * @covers LAND-03
 */
import { describe, test, expect, it } from "bun:test";
import { buildBranchInventory, summarizeInventory, scanBranchesOutsideBase } from "./branch-inventory";

const b = (name: string, ahead = 1) => ({ name, ahead });
const t = (o: Partial<Parameters<typeof buildBranchInventory>[1][number]> & { taskId: string }) => ({
  taskText: "un task", taskStatus: "backlog", ...o,
}) as Parameters<typeof buildBranchInventory>[1][number];

describe("buildBranchInventory", () => {
  test("abbina dal branch di consegna", () => {
    const out = buildBranchInventory([b("topics/uno")], [t({ taskId: "T1", deliveryBranch: "topics/uno" })]);
    expect(out[0]).toMatchObject({ taskId: "T1", matchedBy: "delivery" });
  });

  test("abbina dal worktree quando la consegna non c'è", () => {
    const out = buildBranchInventory([b("topics/due")], [t({ taskId: "T2", worktreeBranch: "topics/due" })]);
    expect(out[0]).toMatchObject({ taskId: "T2", matchedBy: "worktree" });
  });

  test("la CONSEGNA vince sul worktree quando dicono cose diverse", () => {
    // `delivery_branch` è ciò che il task ha dichiarato di aver consegnato e
    // sopravvive alla potatura del worktree; il worktree è solo dove stava.
    const out = buildBranchInventory(
      [b("topics/x")],
      [t({ taskId: "CONSEGNA", deliveryBranch: "topics/x" }), t({ taskId: "WT", worktreeBranch: "topics/x" })],
    );
    expect(out[0]!.taskId).toBe("CONSEGNA");
  });

  test("un ramo senza task resta ORFANO, non viene appiccicato a caso", () => {
    // Nessun ripiego «sul nome che somiglia»: un abbinamento sbagliato manda
    // qualcuno a cercare il lavoro nel task sbagliato, ed è peggio del nulla.
    const out = buildBranchInventory([b("topics/misterioso")], [t({ taskId: "T", deliveryBranch: "topics/altro" })]);
    expect(out[0]).toMatchObject({ taskId: null, matchedBy: "nessuno" });
  });

  test("l'elenco tiene TUTTI i rami, anche quelli abbinati", () => {
    const out = buildBranchInventory([b("a"), b("b")], [t({ taskId: "T", deliveryBranch: "a" })]);
    expect(out).toHaveLength(2);
  });

  test("nessun ramo: elenco vuoto, non un errore", () => {
    expect(buildBranchInventory([], [t({ taskId: "T" })])).toEqual([]);
  });
});

describe("summarizeInventory", () => {
  test("distingue i tre casi, che chiedono tre azioni diverse", () => {
    const entries = buildBranchInventory(
      [b("orfano"), b("aperto"), b("chiuso")],
      [
        t({ taskId: "A", taskStatus: "backlog", deliveryBranch: "aperto" }),
        t({ taskId: "C", taskStatus: "done", deliveryBranch: "chiuso" }),
      ],
    );
    expect(summarizeInventory(entries)).toEqual({
      total: 3, orphan: 1, onOpenTasks: 1, onClosedTasks: 1,
    });
  });

  test("un ramo su task APERTO è il caso che la board non vedeva", () => {
    // Il chip «non su main» conta solo i task chiusi: questo è il buco.
    const entries = buildBranchInventory([b("x")], [t({ taskId: "A", taskStatus: "backlog", deliveryBranch: "x" })]);
    const s = summarizeInventory(entries);
    expect(s.onOpenTasks).toBe(1);
    expect(s.onClosedTasks).toBe(0);
  });

  test("elenco vuoto: tutti zero", () => {
    expect(summarizeInventory([])).toEqual({ total: 0, orphan: 0, onOpenTasks: 0, onClosedTasks: 0 });
  });
});

/**
 * A repo without `main` is not a broken repo.
 *
 * `--no-merged=main` exits non-zero when no such branch exists, and the route
 * turned that into a 500 whose message collapsed two different situations into
 * one sentence. Every e2e sandbox is a fresh repo without `main`, so every run
 * printed those 500s in the middle of the output a real failure has to be found
 * in (card 32fa56d2).
 */
describe("scanBranchesOutsideBase", () => {
  /** A git double: answers by the arguments it is given, and records them. */
  function fakeGit(reply: (args: string[]) => { code: number; stdout?: string }) {
    const seen: string[][] = [];
    const run = async (_cwd: string, args: string[]) => {
      seen.push(args);
      const r = reply(args);
      return { code: r.code, stdout: r.stdout ?? "", stderr: "" };
    };
    return { run, seen };
  }

  it("a repo WITHOUT main and without master is `no-base`, not a failure", async () => {
    const git = fakeGit((args) => {
      if (args[0] === "rev-parse" && args.includes("--git-dir")) return { code: 0, stdout: ".git\n" };
      return { code: 1 }; // neither main nor master
    });
    expect(await scanBranchesOutsideBase("/repo", git.run, () => true)).toEqual({ kind: "no-base" });
    // And it never asked for the branches: with no base the question does not exist.
    expect(git.seen.some((a) => a[0] === "for-each-ref")).toBe(false);
  });

  it("a folder that vanished IS the alarm: branches nobody can see must not read as none", async () => {
    const git = fakeGit(() => ({ code: 0 }));
    expect(await scanBranchesOutsideBase("/gone", git.run, () => false)).toEqual({ kind: "no-path" });
    // And git was never called: the question dies before it.
    expect(git.seen).toEqual([]);
  });

  it("a real folder without git is `not-a-repo`: an empty answer, not a failure", async () => {
    const git = fakeGit(() => ({ code: 1 }));
    expect(await scanBranchesOutsideBase("/not-a-repo", git.run, () => true)).toEqual({ kind: "not-a-repo" });
  });

  it("falls back to `master` and compares against IT, not against a hardcoded main", async () => {
    const git = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[3] === "refs/heads/main") return { code: 1 };
      if (args[0] === "rev-parse" && args[3] === "refs/heads/master") return { code: 0, stdout: "abc\n" };
      if (args[0] === "for-each-ref") return { code: 0, stdout: "feature/x\n" };
      if (args[0] === "rev-list") return { code: 0, stdout: "3\n" };
      return { code: 1 };
    });
    expect(await scanBranchesOutsideBase("/repo", git.run, () => true)).toEqual({
      kind: "ok",
      base: "master",
      branches: [{ name: "feature/x", ahead: 3 }],
    });
    expect(git.seen.find((a) => a[0] === "for-each-ref")).toContain("--no-merged=master");
    expect(git.seen.find((a) => a[0] === "rev-list")).toContain("master..feature/x");
  });

  it("with main present it reads the branches and how far ahead each one is", async () => {
    const git = fakeGit((args) => {
      if (args[0] === "rev-parse" && args[3] === "refs/heads/main") return { code: 0, stdout: "abc\n" };
      if (args[0] === "for-each-ref") return { code: 0, stdout: "topics/uno\ntopics/due\n" };
      if (args[0] === "rev-list") return { code: 0, stdout: args[2]!.includes("uno") ? "2\n" : "0\n" };
      return { code: 1 };
    });
    expect(await scanBranchesOutsideBase("/repo", git.run, () => true)).toEqual({
      kind: "ok",
      base: "main",
      branches: [{ name: "topics/uno", ahead: 2 }, { name: "topics/due", ahead: 0 }],
    });
  });
});
