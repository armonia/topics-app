/**
 * La riga che conta è quella ORFANA: un ramo senza task è quello che nessuno
 * reclamerà, e se l'abbinamento lo nasconde dentro un task sbagliato l'elenco
 * smette di servire proprio nel caso per cui esiste.
 *
 * @covers LAND-03
 */
import { describe, test, expect } from "bun:test";
import { buildBranchInventory, summarizeInventory } from "./branch-inventory";

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
