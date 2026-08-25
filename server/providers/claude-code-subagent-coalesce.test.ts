/**
 * Accorpamento degli aggiornamenti di sub-agent.
 *
 * Ogni azione di un sub-agent (Task tool) faceva partire tre operazioni O(n)
 * sull'INTERO elenco delle azioni: la copia profonda in `sidechain.snapshot()`,
 * una scrittura su DB del `detail` completo e un broadcast del medesimo. Con il
 * tetto di 200 azioni sono ~20.100 elementi copiati, riscritti e spediti per una
 * sola invocazione di Task() — quadratico in qualcosa che l'utente vede come una
 * lista che si allunga.
 *
 * Il contenuto è uno SNAPSHOT, non un delta — il renderer collassa per `callId`
 * e mostra sempre l'ultimo stato — quindi i fotogrammi intermedi sono scartabili
 * per costruzione. Ciò che NON è scartabile: l'ultimo stato, e uno stato
 * `finished`.
 * @covers SUBAGENT-02
 */
import { describe, test, expect } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";

const PARENT = "toolu_parent";

/** Id univoci fra chiamate: il tracker mappa child→parent per id. */
let burstSeq = 0;

function ppWithSidechain() {
  const sidechain = new SidechainTracker();
  sidechain.registerParent(PARENT, { subagent_type: "general-purpose", description: "cerca i bug" });
  const updates: { actions: number; finished: boolean }[] = [];
  const pp = {
    sidechain,
    subAgentEmit: new Map(),
    heartbeatInterval: null,
    streamHandler: {
      onSubAgentUpdate: (_id: string, snap: { actions: unknown[]; finished: boolean }) => {
        updates.push({ actions: snap.actions.length, finished: snap.finished });
      },
    },
  };
  return { pp, sidechain, updates };
}

/** N azioni consecutive, come una raffica dentro la stessa finestra. */
function burst(sidechain: SidechainTracker, n: number) {
  for (let i = 0; i < n; i++) {
    sidechain.recordChildToolUse(PARENT, `child-${burstSeq++}`, "Read", { file: `f${i}` });
  }
}

describe("emitSubAgent — accorpa le raffiche", () => {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const emit = (pp: unknown) => (provider as any).emitSubAgent(pp, PARENT);

  test("una raffica di 50 azioni non produce 50 invii", () => {
    const { pp, sidechain, updates } = ppWithSidechain();
    for (let i = 0; i < 50; i++) {
      sidechain.recordChildToolUse(PARENT, `child-${burstSeq++}`, "Read", { file: `f${i}` });
      emit(pp);
    }
    // Un ciclo stretto sta tutto dentro la finestra: parte il primo invio
    // (finestra aperta) e gli altri 49 collassano nell'unico timer in coda.
    // Senza accorpamento sarebbero 50 copie profonde, 50 scritture e 50
    // broadcast di un array che nel frattempo cresce.
    expect(updates.length).toBe(1);
    // E il fotogramma emesso e' quello vero, non un array vuoto.
    expect(updates[0]!.actions).toBeGreaterThan(0);
  });

  test("lo stato FINALE arriva comunque, entro la finestra", async () => {
    // È la garanzia che rende l'accorpamento accettabile: saltare fotogrammi va
    // bene solo se l'ultimo non si perde.
    const { pp, sidechain, updates } = ppWithSidechain();
    burst(sidechain, 3);
    emit(pp);              // parte subito
    burst(sidechain, 7);   // totale 10
    emit(pp);              // accodato
    await new Promise((r) => setTimeout(r, 250));
    expect(updates[updates.length - 1]!.actions).toBe(10);
  });

  test("un sub-agent FINITO non aspetta la finestra", () => {
    const { pp, sidechain, updates } = ppWithSidechain();
    burst(sidechain, 2);
    emit(pp);                       // apre la finestra
    const before = updates.length;
    burst(sidechain, 2);
    sidechain.finish(PARENT, "fatto");
    emit(pp);                       // finished → bypassa l'accorpamento
    expect(updates.length).toBe(before + 1);
    expect(updates[updates.length - 1]!.finished).toBe(true);
  });

  test("a sub-agent finito lo slot è dimenticato: nessun timer sopravvive", () => {
    const { pp, sidechain } = ppWithSidechain();
    burst(sidechain, 2);
    emit(pp);
    sidechain.finish(PARENT, "fatto");
    emit(pp);
    expect(pp.subAgentEmit.size).toBe(0);
  });

  test("lo snapshot si prende al momento dell'INVIO, non dell'accodamento", async () => {
    // Se lo prendesse quando la finestra si apre, il timer spedirebbe uno stato
    // già vecchio — e la copia profonda dei fotogrammi saltati sarebbe fatta
    // comunque, cioè il costo che questa modifica esiste per togliere.
    const { pp, sidechain, updates } = ppWithSidechain();
    emit(pp);              // invio immediato con 0 azioni
    burst(sidechain, 1);
    emit(pp);              // accodato con 1 azione…
    burst(sidechain, 4);   // …ma quando parte ce ne sono 5
    await new Promise((r) => setTimeout(r, 250));
    expect(updates[updates.length - 1]!.actions).toBe(5);
  });
});
