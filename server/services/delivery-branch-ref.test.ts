/**
 * Il ripiego che tiene in vita la fotografia della consegna quando la catena
 * `task → topic → worktree` si spezza, e il limite oltre il quale NON deve
 * andare: mai la punta di un ramo indovinato, mai un ramo che non esiste più.
 */
import { describe, test, expect } from "bun:test";
import {
  resolveDeliveryBranch,
  type DeliveryBranchDeps,
  type DeliveryWorktree,
  type RecordedDelivery,
} from "./delivery-branch-ref";

const WT: DeliveryWorktree = {
  mode: "branch",
  branchName: "topics/vivid-kite",
  projectId: "store-uuid",
  absPath: "/wt/vivid-kite",
};

const CARD: RecordedDelivery = { projectId: "topics-app-ar3jt5", deliveryBranch: "topics/vivid-kite" };

function deps(over: Partial<DeliveryBranchDeps> = {}): DeliveryBranchDeps {
  return {
    worktreeOfTask: () => WT,
    storeRepoPath: () => "/repo",
    recordedDelivery: () => CARD,
    boardRepoPath: () => "/repo",
    branchExists: async () => true,
    ...over,
  };
}

describe("resolveDeliveryBranch", () => {
  test("col worktree vivo risponde il worktree, cartella compresa", async () => {
    const ref = await resolveDeliveryBranch(deps(), "t1");
    expect(ref).toEqual({
      repoPath: "/repo",
      branch: "topics/vivid-kite",
      worktreePath: "/wt/vivid-kite",
      source: "worktree",
    });
  });

  /**
   * LA REGRESSIONE. Il GC su free-checkout stacca la cartella e scrive il ramo
   * sulla card apposta (`stampDeliveryBranch`), ma `worktreeOfTask` da quel
   * momento risponde `null` e il backfill periodico non fotografava più niente:
   * `delivery_commit` restava NULL per sempre, e con lui l'accusa dell'audit.
   */
  test("senza worktree ripiega sul ramo che la card si è tenuta", async () => {
    const ref = await resolveDeliveryBranch(deps({ worktreeOfTask: () => null }), "t1");
    expect(ref).toEqual({
      repoPath: "/repo",
      branch: "topics/vivid-kite",
      worktreePath: null,
      source: "card",
    });
  });

  test("la cartella NON si eredita dal ripiego: chi misura l'albero deve saperlo", async () => {
    const ref = await resolveDeliveryBranch(deps({ worktreeOfTask: () => null }), "t1");
    expect(ref?.worktreePath).toBeNull();
  });

  /**
   * Un ramo potato non è un ramo. Restituirlo lo stesso farebbe scrivere a chi
   * chiama «verificato: nessun commit proprio», che è un'affermazione diversa da
   * «non c'è più niente da guardare» e porta a conclusioni opposte.
   */
  test("un ramo che non esiste più non è un ripiego: null", async () => {
    const ref = await resolveDeliveryBranch(
      deps({ worktreeOfTask: () => null, branchExists: async () => false }),
      "t1",
    );
    expect(ref).toBeNull();
  });

  test("senza ramo registrato non si inventa niente", async () => {
    const ref = await resolveDeliveryBranch(
      deps({ worktreeOfTask: () => null, recordedDelivery: () => ({ ...CARD, deliveryBranch: null }) }),
      "t1",
    );
    expect(ref).toBeNull();
  });

  test("un ramo registrato tutto spazi vale come assente", async () => {
    const ref = await resolveDeliveryBranch(
      deps({ worktreeOfTask: () => null, recordedDelivery: () => ({ ...CARD, deliveryBranch: "   " }) }),
      "t1",
    );
    expect(ref).toBeNull();
  });

  test("progetto di board non risolto: nessun repo, nessuna risposta", async () => {
    const ref = await resolveDeliveryBranch(
      deps({ worktreeOfTask: () => null, boardRepoPath: () => null }),
      "t1",
    );
    expect(ref).toBeNull();
  });

  test("card sconosciuta: null, e non si chiede l'esistenza di niente", async () => {
    let chiesto = 0;
    const ref = await resolveDeliveryBranch(
      deps({
        worktreeOfTask: () => null,
        recordedDelivery: () => null,
        branchExists: async () => { chiesto += 1; return true; },
      }),
      "t1",
    );
    expect(ref).toBeNull();
    expect(chiesto).toBe(0);
  });

  /**
   * Un worktree `reuse` o `detached` non ha un ramo di consegna: la card lavora
   * dentro il checkout condiviso. Il ripiego resta l'unica risposta possibile, e
   * va tentato invece di rispondere `null` a colpo sicuro.
   */
  test("worktree senza ramo (reuse/detached): si passa al ripiego", async () => {
    for (const mode of ["reuse", "detached"] as const) {
      const ref = await resolveDeliveryBranch(
        deps({ worktreeOfTask: () => ({ ...WT, mode, branchName: mode === "reuse" ? "topics/x" : null }) }),
        "t1",
      );
      expect(ref?.source).toBe("card");
    }
  });

  test("worktree di ramo con progetto irrisolvibile: si passa al ripiego", async () => {
    const ref = await resolveDeliveryBranch(deps({ storeRepoPath: () => null }), "t1");
    expect(ref?.source).toBe("card");
  });

  /** Il ramo del worktree vince su quello registrato: la card può averne cambiato. */
  test("worktree vivo e ramo registrato diverso: comanda il worktree", async () => {
    const ref = await resolveDeliveryBranch(
      deps({ recordedDelivery: () => ({ ...CARD, deliveryBranch: "topics/vecchio" }) }),
      "t1",
    );
    expect(ref?.branch).toBe("topics/vivid-kite");
  });
});
