/**
 * La regressione vera del bug: una shell in background muore (il CLI esce, la
 * shell prende SIGTERM), la sua riga sparisce dal pannello — ma i figli che
 * aveva spawnato NON muoiono con lei. Restano orfani, reparentati a init, con
 * porte e RAM occupate e nessun bottone Stop a cui siano agganciati.
 *
 * Il fix è a due tempi: mentre la shell è VIVA si cattura lo snapshot del suo
 * sottoalbero (pid → start-time); quando muore, quello snapshot è l'unico handle
 * rimasto per spazzare i nipoti — l'albero dei processi si è già spezzato.
 *
 * Questo test lo prova con processi VERI: un `bash` padre che lascia due figli
 * in background, poi lo si ammazza (come farebbe l'uscita del CLI) e si verifica
 * che lo sweep chiuda i figli sopravvissuti.
 */

import { describe, expect, it } from "bun:test";
import { captureShellTree, esitoShellMorta, sweepOrphanedShellTree } from "./processes";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("sweep dei figli orfani di una shell morta", () => {
  it("cattura il sottoalbero da viva e chiude i figli quando la shell muore", async () => {
    // Un bash che spawna due figli in background e aspetta: lo scheletro di una
    // shell che ha lanciato due server e resta in ascolto.
    const parent = Bun.spawn(["bash", "-c", "sleep 300 & sleep 300 & wait"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const parentPid = parent.pid;

    // La tabella dei processi è cachata (TTL 2s): aspettiamo oltre il TTL così
    // la cattura forza una `ps` fresca che vede i figli appena nati.
    await sleep(2200);

    const meta: any = {
      shellId: "sweep-test",
      sessionKey: "sweep-test-session",
      topicId: null,
      ownerPid: parentPid,
      resolveAttempts: 0,
    };
    await captureShellTree(parentPid, meta);

    const captured = [...(meta.tree?.keys() ?? [])] as number[];
    // I due `sleep` (eventuali subshell escluse dal delete del pid padre).
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(meta.tree).toBeInstanceOf(Map);

    // La shell muore com'è successo nel caso reale: SIGKILL SOLO al padre. I
    // figli NON lo ereditano — restano vivi, reparentati fuori dall'albero.
    process.kill(parentPid, "SIGKILL");
    await sleep(300);
    const orphansAlive = captured.filter(isAlive);
    expect(orphansAlive.length).toBeGreaterThanOrEqual(1);

    // Lo sweep li chiude usando lo snapshot: senza, resterebbero orfani a vita.
    await sweepOrphanedShellTree(meta);
    await sleep(400);
    for (const pid of captured) expect(isAlive(pid)).toBe(false);

    // Lo snapshot è consumato (uno-shot): niente doppioni se richiamato.
    expect(meta.tree).toBeUndefined();
  });

  it("non tocca un pid riciclato: lo start-time deve combaciare", async () => {
    // Snapshot con un pid inesistente ma con uno start-time inventato: al
    // momento dello sweep quel pid o non esiste o (se riciclato) ha un altro
    // start-time → l'identity guard lo salta. Nessun kill cieco per numero.
    const bogusPid = 999_999; // fuori dal range dei pid attivi
    const meta: any = {
      shellId: "guard-test",
      sessionKey: "guard-test-session",
      topicId: null,
      ownerPid: null,
      resolveAttempts: 0,
      tree: new Map<number, string>([[bogusPid, "Mon Jan  1 00:00:00 2001"]]),
    };
    // Non deve lanciare né uccidere nulla; consuma solo lo snapshot.
    await sweepOrphanedShellTree(meta);
    expect(meta.tree).toBeUndefined();
  });
});

/**
 * «CONCLUSA» E «INTERROTTA» NON SONO LA STESSA COSA.
 *
 * Il 20/08, topic:205d1fbb. L'agente arma un'attesa in background sul batch dei
 * video e dice all'utente che lo sveglierà quando finisce. Un riavvio del
 * server porta via il CLI, l'attesa muore con lui (`[killed]` nel suo file di
 * output), e nessuno sveglia niente. Nel pannello dei processi quella riga
 * risultava «conclusa», identica a un comando arrivato in fondo.
 *
 * L'utente ha chiesto «non vedo se ha fatto Monitor, forse non l'ha fatto?» — e
 * la risposta onesta era: l'attesa c'era, è stata uccisa, e il pannello diceva
 * il contrario. Il lavoro vero, intanto, era finito davvero da mezz'ora.
 */
describe("come finisce una shell in background che non c'è più", () => {
  it("morto il suo processo: è finita, comunque sia andata", () => {
    expect(esitoShellMorta({ shellDead: true, ownerDead: false })).toBe("completed");
    // Anche se cade pure il padre: il suo processo è arrivato a una fine sua.
    expect(esitoShellMorta({ shellDead: true, ownerDead: true })).toBe("completed");
  });

  it("morto il CLI mentre lei girava: è stata INTERROTTA", () => {
    // È il caso del 20/08, e il motivo per cui questa funzione esiste.
    expect(esitoShellMorta({ shellDead: false, ownerDead: true })).toBe("killed");
  });

  it("nessuno dei due morto: non si chiude niente", () => {
    // Difensivo: chiamarla qui sarebbe un errore del chiamante, ma «completed»
    // è la risposta innocua — non inventa un'interruzione che non c'è stata.
    expect(esitoShellMorta({ shellDead: false, ownerDead: false })).toBe("completed");
  });
});
