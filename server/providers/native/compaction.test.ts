/**
 * La compattazione del contesto.
 *
 * Cosa deve restare vero, in ordine di quanto fa male sbagliarlo:
 *
 *   1. la richiesta iniziale NON si perde — un agente che dimentica cosa gli è
 *      stato chiesto continua a lavorare, che è peggio che fermarsi;
 *   2. la conversazione resta VALIDA per l'API — ogni `tool_use` deve avere il
 *      suo `tool_result`, altrimenti la richiesta successiva viene rifiutata e
 *      la compattazione, invece di salvare il turno, lo uccide;
 *   3. il peso cala davvero.
 */
import { describe, expect, test } from "bun:test";
import { estimateTokens, needsCompaction, compact, windowFor } from "./compaction";
import type { AgentMessage } from "./agent-loop";

/** Una conversazione lunga come quella di un agente che ha lavorato sul serio. */
function longHistory(rounds: number, resultSize = 4000): AgentMessage[] {
  const msgs: AgentMessage[] = [{ role: "user", content: "Sistema il bug nel parser." }];
  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: "assistant",
      content: [
        { type: "text", text: `Giro ${i}: leggo un file.` },
        { type: "tool_use", id: `t${i}`, name: "read_file", input: { path: `file${i}.ts` } },
      ],
    });
    msgs.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(resultSize) },
      ],
    });
  }
  return msgs;
}

describe("la stima dei token", () => {
  test("cresce con il contenuto, e conta anche i risultati dei tool", () => {
    const piccola = estimateTokens(longHistory(1, 100));
    const grande = estimateTokens(longHistory(1, 10_000));
    expect(grande).toBeGreaterThan(piccola * 10);
  });

  test("una conversazione vuota costa zero", () => {
    expect(estimateTokens([])).toBe(0);
  });
});

describe("quando intervenire", () => {
  test("una conversazione corta non si tocca", () => {
    expect(needsCompaction(longHistory(1), 200_000)).toBe(false);
  });

  test("una lunga sì, e PRIMA di riempire la finestra", () => {
    const h = longHistory(60, 20_000); // ~300k caratteri di soli risultati
    expect(needsCompaction(h, 200_000)).toBe(true);
    // Il margine è il punto: si interviene sotto il tetto, non sopra.
    expect(estimateTokens(h)).toBeLessThan(200_000 * 2);
  });
});

describe("cosa sopravvive alla compattazione", () => {
  const h = longHistory(40, 5000);
  const out = compact(h);

  test("il peso cala davvero", () => {
    expect(out.after).toBeLessThan(out.before);
    // Non un ritocco: deve liberare la maggior parte del peso, o si torna al
    // tetto due giri dopo.
    expect(out.after).toBeLessThan(out.before / 2);
  });

  // LA COSA CHE NON SI PUÒ PERDERE.
  test("la richiesta iniziale è ancora lì, identica", () => {
    expect(out.messages[0]).toEqual(h[0]!);
  });

  test("la coda recente è intatta: il lavoro appena fatto serve tutto", () => {
    const codaOriginale = h.slice(-6);
    const codaDopo = out.messages.slice(-6);
    expect(codaDopo).toEqual(codaOriginale);
  });

  // IL VINCOLO DELL'API, ed è quello che trasformerebbe la cura in malattia.
  test("ogni tool_use ha ancora il suo tool_result: la storia resta valida", () => {
    const usi = new Set<string>();
    const risultati = new Set<string>();
    for (const m of out.messages) {
      if (typeof m.content === "string") continue;
      for (const b of m.content) {
        if (b.type === "tool_use" && b.id) usi.add(b.id);
        if (b.type === "tool_result" && b.tool_use_id) risultati.add(b.tool_use_id);
      }
    }
    expect(usi.size).toBeGreaterThan(0);
    for (const id of usi) {
      expect(risultati.has(id), `manca il risultato di ${id}`).toBe(true);
    }
  });

  test("i risultati vecchi sono svuotati, non cancellati", () => {
    const vecchio = out.messages[2];
    expect(typeof vecchio!.content).not.toBe("string");
    const b = (vecchio!.content as any[])[0];
    expect(b.type).toBe("tool_result");
    expect(b.content).toContain("rimosso");
  });

  test("l'originale NON viene mutato: chi chiama decide se sostituirlo", () => {
    const primaDelGiro = longHistory(40, 5000);
    const copia = JSON.parse(JSON.stringify(primaDelGiro));
    compact(primaDelGiro);
    expect(primaDelGiro).toEqual(copia);
  });

  test("una conversazione troppo corta per potarla resta com'è", () => {
    const corta = longHistory(1);
    const r = compact(corta);
    expect(r.messages).toEqual(corta);
    expect(r.after).toBe(r.before);
  });
});

describe("la finestra dei modelli", () => {
  test("i modelli noti dichiarano 200k", () => {
    expect(windowFor("claude-opus-4-6")).toBe(200_000);
    expect(windowFor("claude-sonnet-4-6")).toBe(200_000);
    expect(windowFor("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  test("la variante [1m] dichiara un MILIONE, su qualunque famiglia", () => {
    // IL BUG: i rami erano in ordine sbagliato. `opus-4` e `sonnet-4-5` erano
    // controllati PRIMA del suffisso, quindi `claude-opus-4[1m]` usciva a 200k
    // senza mai raggiungere il ramo giusto - misurato il 17/08: due famiglie su
    // quattro. Conseguenza: la conversazione veniva compattata a un quinto
    // della finestra che aveva davvero, cioe' si buttava contesto che c'era.
    expect(windowFor("claude-opus-5[1m]")).toBe(1_000_000);
    expect(windowFor("claude-sonnet-5[1m]")).toBe(1_000_000);
    expect(windowFor("claude-opus-4[1m]")).toBe(1_000_000);
    expect(windowFor("claude-sonnet-4-5[1m]")).toBe(1_000_000);
  });

  test("senza suffisso le stesse famiglie restano a 200k", () => {
    // La domanda che il test sopra da solo non chiude: il suffisso deve
    // ALZARE la finestra, non spostarla per tutti.
    expect(windowFor("claude-opus-4")).toBe(200_000);
    expect(windowFor("claude-sonnet-4-5")).toBe(200_000);
    expect(windowFor("claude-opus-5")).toBe(200_000);
  });

  test("uno sconosciuto prende il valore PRUDENTE, non il più generoso", () => {
    // Sbagliare per eccesso qui significa non compattare in tempo.
    expect(windowFor("modello-mai-visto")).toBe(200_000);
  });
});
