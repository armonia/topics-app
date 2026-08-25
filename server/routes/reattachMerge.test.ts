/**
 * @covers CHAT-BUBBLE-02
 */
import { describe, expect, test } from "bun:test";
import { rowCarriesWork } from "./crashedTurnNotice";
import { mergeReattachedRow, type RowSnapshot } from "./reattachMerge";

const ASK = JSON.stringify([{ id: "toolu_1", name: "mcp__topics__ask_user_question", status: "waiting_for_input" }]);

function snap(over: Partial<RowSnapshot> = {}): RowSnapshot {
  return {
    content: "Ecco cosa ho fatto.",
    thinking: null,
    toolCallsJson: ASK,
    blocksJson: JSON.stringify([{ kind: "text", text: "Ecco cosa ho fatto." }, { kind: "tool", toolCall: { id: "toolu_1" } }]),
    ...over,
  };
}

describe("mergeReattachedRow — riattaccarsi non toglie", () => {
  test("replay MUTO (coda chiusa): il testo torna, i tool restano quelli di prima", () => {
    // È il caso che ha ucciso il pannello sei volte: il provider ri-consegna
    // solo il risultato finale, l'handler non vede nessun tool, e la riga
    // svuotata resterebbe senza la domanda a schermo.
    const m = mergeReattachedRow(snap(), { content: "Ecco cosa ho fatto.", trackedTools: 0, blocks: [] });
    expect(m.toolCallsJson).toBe(ASK);
    expect(m.nothingNew).toBe(true);
  });

  test("riattacco a mani vuote: la riga torna esattamente com'era", () => {
    const m = mergeReattachedRow(snap(), { content: "", trackedTools: 0, blocks: [] });
    expect(m.content).toBe("Ecco cosa ho fatto.");
    expect(m.toolCallsJson).toBe(ASK);
    expect(m.nothingNew).toBe(true);
  });

  test("replay COMPLETO: i tool nuovi vincono, la riga non è un doppione", () => {
    // Coda aperta: il provider ri-emette tutto, compresi i tool. Qui la copia
    // buona è quella nuova — tenere anche la vecchia sarebbe la duplicazione
    // opposta.
    const m = mergeReattachedRow(snap(), {
      content: "Ecco cosa ho fatto. E poi ho continuato.",
      trackedTools: 2,
      blocks: [{ kind: "tool", toolCall: { id: "toolu_1" } }, { kind: "tool", toolCall: { id: "toolu_2" } }],
    });
    expect(m.toolCallsJson).toBeUndefined(); // non toccare: ci ha già pensato l'handler
    expect(m.content).toBe("Ecco cosa ho fatto. E poi ho continuato.");
    expect(m.nothingNew).toBe(false);
  });

  test("il turno riadottato ha prodotto testo NUOVO: non è un doppione", () => {
    const m = mergeReattachedRow(snap(), { content: "Ho finito, ecco il risultato.", trackedTools: 0, blocks: [] });
    expect(m.nothingNew).toBe(false);
    expect(m.content).toBe("Ho finito, ecco il risultato.");
    // …e i tool di prima restano comunque: nessuno li ha ri-emessi.
    expect(m.toolCallsJson).toBe(ASK);
  });

  test("una timeline nuova che ha perso i tool non sostituisce quella vecchia", () => {
    const m = mergeReattachedRow(snap(), {
      content: "Ecco cosa ho fatto.",
      trackedTools: 0,
      blocks: [{ kind: "text", text: "Ecco cosa ho fatto." }],
    });
    expect(Array.isArray(m.blocks)).toBe(true);
    expect((m.blocks as { kind: string }[]).some((b) => b.kind === "tool")).toBe(true);
  });

  test("riga vuota di partenza: non c'è niente da conservare", () => {
    const m = mergeReattachedRow(
      snap({ content: "", toolCallsJson: null, blocksJson: null }),
      { content: "Prima risposta.", trackedTools: 1, blocks: [{ kind: "text", text: "Prima risposta." }] },
    );
    expect(m.toolCallsJson).toBeUndefined();
    expect(m.nothingNew).toBe(false);
  });

  test("tool_calls illeggibile: nel dubbio si conserva", () => {
    const m = mergeReattachedRow(snap({ toolCallsJson: "{rotto" }), { content: "", trackedTools: 0, blocks: [] });
    expect(m.toolCallsJson).toBe("{rotto");
  });

  test("il pensiero non si perde se il riattacco non ne porta", () => {
    const m = mergeReattachedRow(snap({ thinking: "stavo ragionando" }), { content: "", trackedTools: 0, blocks: [] });
    expect(m.thinking).toBe("stavo ragionando");
  });

  test("la riga svuotata dice «vuota» PRIMA del merge e «piena» DOPO: si decide dopo", () => {
    // Il difetto vero, visto in produzione il 7 agosto: un turno con 54 tool e
    // 14 blocchi di testo è finito etichettato «Nessuna risposta: il turno si è
    // chiuso senza produrre niente».
    //
    // La riadozione SVUOTA la riga per riusarla, e ciò che la riempiva torna
    // solo di qui. Una guardia che guarda le colonne giuste ma PRIMA del merge
    // vede una riga azzerata da qualcun altro e conclude che non è stato
    // prodotto niente. Le colonne erano giuste; era sbagliato il momento.
    const snapshot = snap({
      content: "",
      toolCallsJson: JSON.stringify([{ id: "toolu_1" }, { id: "toolu_2" }]),
      blocksJson: JSON.stringify([{ kind: "text", text: "l'analisi" }, { kind: "tool", toolCall: { id: "toolu_1" } }]),
    });
    // Com'è la riga in DB durante il turno riadottato: azzerata.
    expect(rowCarriesWork({ content: "", toolCallsJson: null, blocksJson: null })).toBe(false);

    // Dopo il merge, con un replay muto (niente prodotto), torna quella di prima.
    const merged = mergeReattachedRow(snapshot, { content: "", trackedTools: 0, blocks: [] });
    expect(rowCarriesWork({
      content: merged.content,
      toolCallsJson: merged.toolCallsJson ?? null,
      blocksJson: merged.blocks ? JSON.stringify(merged.blocks) : null,
    })).toBe(true);
  });

  test("il VERDETTO sopravvive anche quando si tengono i blocchi vecchi", () => {
    // Il verdetto non è mai «vecchio»: dice come è finita ADESSO, e lo snapshot
    // per definizione non ce l'ha. Tenendo i blocchi di prima e basta, l'unica
    // cosa che spiega il fallimento della riadozione veniva buttata — e a quel
    // punto nemmeno `content` la porta, perché il testo rifuso è non vuoto.
    const m = mergeReattachedRow(
      snap(),
      { content: "", trackedTools: 0, blocks: [{ kind: "error", text: "Riadozione non riuscita: ack timeout" }] },
    );
    const kinds = (m.blocks as Array<{ kind: string }>).map((b) => b.kind);
    expect(kinds).toEqual(["text", "tool", "error"]);
    expect(m.content).toBe("Ecco cosa ho fatto."); // il turno di prima resta intero
  });
});

describe("mergeReattachedRow — i salvataggi a metà replay non sottraggono", () => {
  // La riga non viene più svuotata all'adozione, quindi durante il replay
  // porta ancora il turno intero di prima. I salvataggi periodici (ogni 10
  // chunk) ci scrivono sopra il replay MENTRE cresce: fino a quando non ha
  // raggiunto il testo di prima, quella scrittura è una potatura — e diventa
  // definitiva se proprio lì il server muore di nuovo.
  test("replay a un terzo: in riga resta il testo intero di prima", () => {
    const m = mergeReattachedRow(snap(), { content: "Ecco", trackedTools: 0, blocks: [] }, "progress");
    expect(m.content).toBe("Ecco cosa ho fatto.");
  });

  test("replay che ha raggiunto e superato: vince il testo nuovo", () => {
    const m = mergeReattachedRow(
      snap(),
      { content: "Ecco cosa ho fatto. E poi ho continuato.", trackedTools: 1, blocks: [] },
      "progress",
    );
    expect(m.content).toBe("Ecco cosa ho fatto. E poi ho continuato.");
  });

  test("alla fine, invece, il verdetto del turno vince anche se è più corto", () => {
    // `final` è l'ultima parola: il provider ha ri-consegnato solo il testo
    // finale e quello è il turno, non un replay a metà.
    const m = mergeReattachedRow(snap(), { content: "Fatto.", trackedTools: 0, blocks: [] }, "final");
    expect(m.content).toBe("Fatto.");
  });
});
