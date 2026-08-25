/**
 * Il guasto da cui nasce questo file, misurato il 2026-08-18 su topic:9fe7a291:
 * ho premuto Rigenera su una risposta sbagliata e ne è uscita una risposta
 * INVENTATA — con dentro `<invoke name="Bash">…</invoke>` scritto come testo e
 * gli output dei comandi immaginati («Non nessuna mail di Giovanni trovata in
 * quel range»). `tool_calls` vuoto, `blocks` vuoto, sessione CLI ferma al byte:
 * nessuno di quei comandi è mai girato.
 *
 * La causa non è il bottone: è che quel percorso chiama `complete()`, che gira
 * senza strumenti su entrambi i runtime (`--tools ""` sulla CLI, `tools: []` sul
 * nativo), mentre il prompt del topic continua a descriverli. Qui si prova il
 * pezzo di prompt che chiude il buco.
  * @covers CHAT-CONV-04
 */
import { test, expect, describe } from "bun:test";
import {
  formatRegenerationEvidence,
  regenerationPromptBlock,
  NO_TOOLS_NOTICE,
  type EvidenceToolCall,
} from "./regenerate-evidence";

const bash = (command: string, result?: string, extra?: Partial<EvidenceToolCall>): EvidenceToolCall => ({
  name: "Bash", args: { command }, status: "success", result, ...extra,
});

describe("formatRegenerationEvidence — le prove del turno che si riscrive", () => {
  test("nessuna azione ⇒ null (che NON vuol dire «niente da dire»)", () => {
    expect(formatRegenerationEvidence([])).toBeNull();
    expect(formatRegenerationEvidence(undefined)).toBeNull();
  });

  test("un comando con il suo esito arriva intero: nome, ingresso, esito", () => {
    const out = formatRegenerationEvidence([bash("wc -l server/lib/*.test.ts", "15164 total")])!;
    expect(out).toContain("Bash");
    expect(out).toContain("wc -l server/lib/*.test.ts");
    expect(out).toContain("15164 total");
  });

  /**
   * È la regola che conta di più. Una chiamata senza esito registrato non è una
   * chiamata riuscita, e lasciarla muta è un invito a riempirla d'immaginazione
   * — cioè esattamente il guasto da cui nasce questo file.
   */
  test("un'azione SENZA esito lo dichiara, non tace", () => {
    const out = formatRegenerationEvidence([bash("git push")])!;
    expect(out).toContain("nessun esito registrato");
    expect(out).toContain("NON dare per scontato");
  });

  /**
   * La riga scritta oggi sul disco puo' NON avere `result`: quando `detail`
   * porta gia' quella stessa stringa byte per byte, la copia non viene piu'
   * scritta (`toolCallsForDisk`). Rigenera e' l'unico consumatore server che
   * leggeva l'esito da li', e senza questo l'operazione «senza perdita»
   * perderebbe proprio la cosa che serve al modello: le misure.
   */
  test("l'esito si recupera da `detail` quando la copia in `result` non e' stata scritta", () => {
    const out = formatRegenerationEvidence([{
      name: "Bash", args: { command: "wc -l" }, status: "success",
      detail: { type: "shell", command: "wc -l", output: "15164 total" },
    }])!;
    expect(out).toContain("15164 total");
    expect(out).not.toContain("nessun esito registrato");
  });

  test("una chiamata senza esito NE' in `result` NE' in `detail` resta dichiarata muta", () => {
    const out = formatRegenerationEvidence([{
      name: "Read", args: { file_path: "/x" }, status: "running",
      detail: { type: "read", filePath: "/x" },
    }])!;
    expect(out).toContain("nessun esito registrato");
  });

  test("un'azione fallita si legge come fallita", () => {
    const out = formatRegenerationEvidence([bash("gws-mail armonia search", undefined, { error: "command not found" })])!;
    expect(out).toContain("ERRORE");
    expect(out).toContain("command not found");
  });

  test("gli argomenti lunghi si tagliano DICENDOLO", () => {
    const out = formatRegenerationEvidence([bash("x".repeat(5000), "ok")], { maxChars: 100 })!;
    expect(out).toContain("troncato");
    expect(out).toContain("caratteri in più");
    expect(out.length).toBeLessThan(1000);
  });

  /** Niente tagli muti: «ecco le prove» non deve leggersi come «ecco TUTTE le prove». */
  test("oltre il tetto di azioni si dice quante restano fuori", () => {
    const many = Array.from({ length: 12 }, (_, i) => bash(`cmd-${i}`, `out-${i}`));
    const out = formatRegenerationEvidence(many, { maxCalls: 5 })!;
    expect(out).toContain("cmd-4");
    expect(out).not.toContain("cmd-5");
    expect(out).toContain("altre 7 azioni non riportate");
    // Il conto totale resta vero anche quando la lista è parziale.
    expect(out).toContain("12 azioni");
  });

  test("un solo argomento si stampa nudo, senza le graffe del JSON", () => {
    const out = formatRegenerationEvidence([{ name: "Read", args: { file_path: "/tmp/a.ts" }, result: "ciao" }])!;
    expect(out).toContain("file_path: /tmp/a.ts");
    expect(out).not.toContain('{"file_path"');
  });

  test("più argomenti restano JSON", () => {
    const out = formatRegenerationEvidence([{ name: "Edit", args: { path: "a.ts", old: "x" }, result: "ok" }])!;
    expect(out).toContain('"path"');
  });
});

describe("regenerationPromptBlock — il vincolo non è opzionale", () => {
  /**
   * Anche un turno di sola prosa non ha tool call, ma il preambolo del topic gli
   * ha comunque descritto gli strumenti: senza questa riga resta libero di
   * recitarli.
   */
  test("senza prove resta comunque la dichiarazione «non hai strumenti»", () => {
    expect(regenerationPromptBlock([])).toBe(NO_TOOLS_NOTICE);
    expect(regenerationPromptBlock(undefined)).toContain("NON hai strumenti");
  });

  test("con le prove, il vincolo viene PRIMA di esse", () => {
    const out = regenerationPromptBlock([bash("ls", "a\nb")]);
    expect(out.indexOf("NON hai strumenti")).toBeLessThan(out.indexOf("Misure già raccolte"));
  });

  test("dice esplicitamente di non fingere una chiamata a uno strumento", () => {
    expect(regenerationPromptBlock([])).toContain("come se l'avessi");
  });
});
