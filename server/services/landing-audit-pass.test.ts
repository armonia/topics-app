/**
 * IL VERDETTO DELL'AUDIT DEVE ARRIVARE ALLO SCHERMO.
 *
 * `landingState` e' l'unica cosa che questa passata cambia, ed e' anche una
 * delle poche che si vedono da lontano: la pastiglia «non e' su main» sulla
 * card, la banda in cima al drawer, il contatore del debito in testa alla
 * board. Ma la passata gira da un `setInterval`, non da una rotta, quindi
 * nessuno trasmetteva il suo esito: fino al 19/08/2026 `record` scriveva la
 * colonna e taceva.
 *
 * Il caso che si pagava era il migliore dei due. Una card ACCUSATA che poi
 * atterra davvero resta accusata su ogni schermo aperto finche' qualcuno non
 * ricarica: il rimedio a un guasto ha la faccia del guasto, e chi guarda la
 * board impara a non fidarsene.
 *
 * Qui si monta un repo git vero, come in `landing-audit-recovery.test.ts`: la
 * domanda «e' su main?» la devono reggere i comandi git, non un doppio che
 * risponde quello che voglio io.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLandingAudit, type AuditWiring } from "./landing-audit-pass";
import type { AuditTask, LandingState } from "./landing-audit";
import { projectIdForPath } from "./tasks";
import type { ProjectStore } from "./project-store";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(r.stdout).trim();
}

function commit(repo: string, file: string, body: string, msg: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

/** Righe lunghe: sotto i 60 caratteri il verdetto per contenuto non ha impronte. */
const RIGA = (n: number) => `export const valoreDistintivoNumeroDavveroLungoPerIlTest${n} = ${n}; // ${"x".repeat(30)}\n`;

let repo: string;
let boardId = "";
let commitAtterrato = "";
let commitFuori = "";

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "landing-pass-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
  const base = commit(repo, "base.ts", RIGA(0), "base");
  // `tasks.project_id` e' l'hash a senso unico del percorso: e' cosi' che
  // l'audit ritrova il checkout da guardare, e usare l'hash vero e' l'unico
  // modo di provare che il cablaggio regge.
  boardId = projectIdForPath(repo);

  // La card ATTERRATA: ramo fuso su main con `--no-ff`, come fa il land.
  git(repo, "checkout", "-q", "-b", "topics/atterrata", base);
  commitAtterrato = commit(repo, "atterrata.ts", RIGA(1), "il lavoro atterrato");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "--no-ff", "-q", "-m", "merge topics/atterrata", "topics/atterrata");

  // La card FUORI: un ramo con lavoro suo che su main non c'e'. Cinque righe e
  // non una: sotto `RIGHE_MINIME` (3) il verdetto per contenuto si rifiuta di
  // decidere, e il test misurerebbe la propria fixture invece del codice.
  git(repo, "checkout", "-q", "-b", "topics/fuori", base);
  commitFuori = commit(repo, "fuori.ts", [2, 3, 4, 5, 6].map(RIGA).join(""), "il lavoro rimasto fuori");
  git(repo, "checkout", "-q", "main");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

/** La card come la vede il servizio task, con lo stato che l'audit riscrive. */
interface CardFinta extends AuditTask {
  landingState: LandingState | null;
}

interface Banco {
  wiring: AuditWiring;
  card: CardFinta;
  /** Ogni frame passato a `broadcast`, in ordine. */
  annunci: Array<{ type?: string; projectId?: string; task?: CardFinta }>;
  commenti: string[];
}

function banco(card: Partial<CardFinta> & { id: string }): Banco {
  const piena: CardFinta = {
    projectId: boardId,
    deliveryBranch: null,
    deliveryCommit: null,
    landingState: null,
    ...card,
  };
  const annunci: Banco["annunci"] = [];
  const commenti: string[] = [];
  const wiring: AuditWiring = {
    // Nessun progetto registrato: il checkout arriva da `extraPaths`, che e'
    // l'unione con cui il server risolve i progetti aperti a mano.
    projectStore: { list: () => [] } as unknown as ProjectStore,
    workspaceDir: join(repo, "workspace-che-non-esiste"),
    extraPaths: () => [repo],
    svc: {
      addComment: (a) => { commenti.push(a.content); return null; },
      get: (id) => (id === piena.id ? { task: piena } : null),
      recordLandingState: (a) => { piena.landingState = a.state; return null; },
      listLandingAuditCandidates: () => [piena],
    },
    broadcast: (msg) => { annunci.push(msg as Banco["annunci"][number]); },
    backfill: async () => {},
  };
  return { wiring, card: piena, annunci, commenti };
}

describe("l'audit annuncia i verdetti che cambiano", () => {
  test("una card ACCUSATA che e' atterrata davvero esce sul filo, col nuovo stato", async () => {
    // Il caso per cui esiste il frame: la pastiglia rossa deve SPEGNERSI da
    // sola. Senza broadcast la card restava accusata su ogni schermo aperto,
    // e l'unico modo di vedere il verdetto giusto era ricaricare la pagina.
    const b = banco({ id: "card-atterrata", deliveryBranch: "topics/atterrata", deliveryCommit: commitAtterrato, landingState: "unlanded" });

    const esito = await runLandingAudit(b.wiring);

    expect(esito!.landed).toBe(1);
    expect(b.card.landingState).toBe("landed");
    expect(b.annunci).toHaveLength(1);
    expect(b.annunci[0]).toMatchObject({ type: "task:updated", projectId: boardId });
    // Il frame porta lo stato NUOVO. Trasmettere la riga com'era prima della
    // scrittura sarebbe un frame che non cambia niente sul client: il rumore
    // di una correzione senza la correzione.
    expect(b.annunci[0]!.task?.landingState).toBe("landed");
  });

  test("un verdetto che non cambia NON trasmette niente", async () => {
    // `record` timbra ogni candidata a ogni giro, e le card di una board sono
    // centinaia: un frame per ognuna ogni mezz'ora vorrebbe dire far
    // ri-scaricare la board intera a tutti i client per non dire nulla di
    // nuovo. Il rimedio a una board ferma non puo' essere una board che si
    // ricarica da sola duecento volte.
    const b = banco({ id: "card-ferma", deliveryBranch: "topics/atterrata", deliveryCommit: commitAtterrato, landingState: "landed" });

    await runLandingAudit(b.wiring);

    expect(b.card.landingState).toBe("landed");
    expect(b.annunci).toEqual([]);
  });

  test("una consegna davvero fuori da main viene annunciata, e detta nel thread", async () => {
    const b = banco({ id: "card-fuori", deliveryBranch: "topics/fuori", deliveryCommit: commitFuori, landingState: null });

    const esito = await runLandingAudit(b.wiring);

    expect(esito!.unlanded).toBe(1);
    expect(b.card.landingState).toBe("unlanded");
    expect(b.commenti).toHaveLength(1);
    // DUE frame, e non sono lo stesso fatto detto due volte: il primo porta lo
    // stato appena scritto sulla colonna, il secondo la riga appena aggiunta al
    // thread. Il secondo esisteva gia' prima di questo lavoro (`onNewlyUnlanded`
    // annunciava il suo commento), il primo e' quello che mancava.
    expect(b.annunci).toHaveLength(2);
    expect(b.annunci.every((a) => a.type === "task:updated" && a.projectId === boardId)).toBe(true);
    expect(b.annunci[0]!.task?.landingState).toBe("unlanded");
  });

  test("il `projectId` annunciato e' quello della CARD", async () => {
    // Il client filtra i `task:updated` per l'id di board. Un id di un altro
    // namespace non solleva niente: il frame arriva e viene scartato, cioe'
    // lo stesso silenzio di prima con in piu' la banda occupata.
    const b = banco({ id: "card-id", deliveryBranch: "topics/atterrata", deliveryCommit: commitAtterrato, landingState: "unlanded" });

    await runLandingAudit(b.wiring);

    expect(b.annunci[0]!.projectId).toBe(b.card.projectId);
    expect(b.annunci[0]!.task?.id).toBe("card-id");
  });
});
