/**
 * LA CATENA DI RECUPERO, SU GIT VERO.
 *
 * I due guasti misurati il 18/08 sulla board di topics-app si tengono per mano,
 * e ognuno da solo sembra un altro problema:
 *
 *   1. `delivery_commit` restava NULL su 23 card in review/done. Non per la
 *      sottrazione dei commit propri: per la catena
 *      `task → assignedTopicId → topic.worktreeId → worktrees`, che si spezza da
 *      sola (re-dispatch, GC su free-checkout, reap) e portava con sé l'unica
 *      strada per sapere su quale ramo guardare. Il ramo però la card ce l'ha:
 *      lo scrive il GC apposta prima di liberare la cartella.
 *   2. 13 di quelle card portavano «non è su main». Non per un verdetto
 *      sbagliato: per un verdetto MAI RIFATTO. `markLandPending` timbra
 *      `unlanded` appena il land viene chiesto, e i candidati dell'audit
 *      filtravano `delivery_commit IS NOT NULL` — cioè escludevano esattamente
 *      loro. L'accusa era definitiva, la più vecchia ferma da sei giorni.
 *
 * Qui si monta un repo vero e si percorre la catena intera, perché sono i
 * comandi git a doverla reggere: un doppio di test proverebbe solo che so
 * scrivere il doppio.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDeliveryBranch, type DeliveryBranchDeps } from "./delivery-branch-ref";
import { branchExistsInRepo, commitStatusFromRepo, worktreeDiffStat } from "./branch-status";
import { deliveryPointer } from "./own-commits";
import { landedMergeRange } from "./task-diff-range";
import { auditLandings, classifyLanding, type AuditTask, type LandingState } from "./landing-audit";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
  return new TextDecoder().decode(r.stdout).trim();
}

function commit(repo: string, file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

/** Una riga lunga: sotto i 60 caratteri il verdetto per contenuto non ha impronte. */
const RIGA = (n: number) => `export const valoreDistintivoNumeroDavveroLungoPerIlTest${n} = ${n}; // ${"x".repeat(30)}\n`;

const CARD_VIVA = "11111111-aaaa-4aaa-8aaa-111111111111";
const CARD_ATTERRATA = "22222222-bbbb-4bbb-8bbb-222222222222";

let repo: string;
let commitProprio = "";
let commitAtterrato = "";

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "landing-recovery-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  const base = commit(repo, "base.ts", RIGA(0), "base");

  // Un ALTRO ramo di card, così la sottrazione `--not <altri>` ha da lavorare:
  // senza, il test proverebbe la sottrazione a vuoto.
  git(repo, "checkout", "-q", "-b", "topics/altro", base);
  commit(repo, "altro.ts", RIGA(9), "lavoro di un'altra card");

  // La card VIVA: ramo con un commit suo, mai atterrato.
  git(repo, "checkout", "-q", "-b", "topics/card-viva", base);
  commitProprio = commit(repo, "viva.ts", RIGA(1), "il lavoro della card viva");

  // La card ATTERRATA: ramo fuso su main con `--no-ff` come fa il land, e poi
  // POTATO. Non le resta né worktree, né ramo, né commit registrato.
  git(repo, "checkout", "-q", "-b", "topics/card-atterrata", base);
  commitAtterrato = commit(repo, "atterrata.ts", RIGA(2), "il lavoro della card atterrata");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "--no-ff", "-q", "-m", `merge task ${CARD_ATTERRATA}: il lavoro della card atterrata`, "topics/card-atterrata");
  git(repo, "branch", "-q", "-D", "topics/card-atterrata");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

/** Le dipendenze del server, con la catena del worktree SPEZZATA come nel guasto. */
function deps(over: Partial<DeliveryBranchDeps> = {}): DeliveryBranchDeps {
  return {
    worktreeOfTask: () => null, // la cartella non c'è più: è tutto il punto
    storeRepoPath: () => null,
    recordedDelivery: (id) => ({
      projectId: "board-hash",
      deliveryBranch: id === CARD_VIVA ? "topics/card-viva" : "topics/card-atterrata",
    }),
    boardRepoPath: () => repo,
    branchExists: (r, b) => branchExistsInRepo(r, b),
    ...over,
  };
}

describe("recupero della consegna quando il worktree non c'è più", () => {
  test("il ramo scritto sulla card basta a ritrovare il commit PROPRIO", async () => {
    const ref = await resolveDeliveryBranch(deps(), CARD_VIVA);
    expect(ref).toMatchObject({ repoPath: repo, branch: "topics/card-viva", worktreePath: null });

    const ptr = await deliveryPointer(ref!.repoPath, ref!.branch);
    expect(ptr?.commit).toBe(commitProprio);
  });

  test("e il commit ritrovato è SUO, non quello dell'altra card", async () => {
    const ptr = await deliveryPointer(repo, "topics/card-viva");
    expect(ptr!.commit).not.toBe(git(repo, "rev-parse", "topics/altro"));
  });

  /**
   * Senza cartella la misura si fa sul checkout del progetto: la domanda è
   * tutta sui ref, che i worktree di un repo condividono, e `worktreeDiffStat`
   * confronta due commit — l'albero di lavoro non entra nella risposta.
   */
  test("anche il diffstat si misura dal checkout, senza la cartella", async () => {
    const stat = await worktreeDiffStat(repo, { branch: "topics/card-viva" });
    expect(stat).toMatchObject({ commit: commitProprio, filesChanged: 1 });
    expect(stat!.insertions).toBeGreaterThan(0);
  });

  test("un ramo già potato non è un ripiego: nessun ritratto inventato", async () => {
    expect(await resolveDeliveryBranch(deps(), CARD_ATTERRATA)).toBeNull();
  });
});

describe("l'accusa su una card di cui non resta niente", () => {
  /** L'audit vero, coi comandi git veri dietro le sue dipendenze. */
  async function audit(task: AuditTask, before: LandingState | null) {
    const recorded: Array<{ id: string; state: LandingState }> = [];
    const alerts: string[] = [];
    await auditLandings({
      listCandidates: () => [task],
      repoPath: () => repo,
      commitStatus: (r, c) => commitStatusFromRepo(r, c),
      landedMerge: async (t, r) => ((await landedMergeRange(r, t.id)) ? true : null),
      record: (id, state) => { recorded.push({ id, state }); },
      previousState: () => before,
      onNewlyUnlanded: (t) => { alerts.push(t.id); },
      now: () => "2026-08-18T06:00:00.000Z",
      log: () => {},
    });
    return { recorded, alerts };
  }

  /**
   * IL CASO CHE HA TENUTO 13 CARD SOTTO ACCUSA. Nessun commit registrato, ramo
   * potato: l'unica prova rimasta è il merge che il land ha scritto su main col
   * nome della card. È la stessa che un umano va a cercare a mano.
   */
  test("il merge del land su main la assolve, e il verdetto è `landed`", async () => {
    const { recorded, alerts } = await audit(
      { id: CARD_ATTERRATA, projectId: "board-hash", deliveryBranch: "topics/card-atterrata", deliveryCommit: null },
      "unlanded",
    );
    expect(recorded).toEqual([{ id: CARD_ATTERRATA, state: "landed" }]);
    expect(alerts).toEqual([]);
  });

  test("senza merge e senza commit resta «non lo so», mai un'accusa", async () => {
    const { recorded } = await audit(
      { id: CARD_VIVA, projectId: "board-hash", deliveryBranch: "topics/card-viva", deliveryCommit: null },
      "unlanded",
    );
    expect(recorded).toEqual([{ id: CARD_VIVA, state: "unverifiable" }]);
  });

  /**
   * La controprova che il recupero non è un'assoluzione generale: una card che
   * ha davvero del lavoro fuori da main resta accusata, e il merge di un'ALTRA
   * card non la copre.
   */
  test("un commit davvero fuori da main resta `unlanded`", async () => {
    expect(classifyLanding(await commitStatusFromRepo(repo, commitProprio))).toBe("unlanded");
    const { recorded, alerts } = await audit(
      { id: CARD_VIVA, projectId: "board-hash", deliveryBranch: "topics/card-viva", deliveryCommit: commitProprio },
      null,
    );
    expect(recorded).toEqual([{ id: CARD_VIVA, state: "unlanded" }]);
    expect(alerts).toEqual([CARD_VIVA]);
  });

  test("il commit di una card atterrata è `landed` per discendenza, come prima", async () => {
    expect(classifyLanding(await commitStatusFromRepo(repo, commitAtterrato))).toBe("landed");
  });
});
