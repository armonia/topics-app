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
  * @covers RT-03
 */
import { describe, expect, test } from "bun:test";
import {
  estimateTokens, needsCompaction, compact, windowFor, clipToolResult,
  estimateChars, charsPerTokenFrom, promptTooLong,
} from "./compaction";
import type { AgentMessage, Block } from "./agent-loop";

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
    const originalQueue = h.slice(-6);
    const queueAfter = out.messages.slice(-6);
    expect(queueAfter).toEqual(originalQueue);
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

/**
 * THE 400 THAT REPEATED FOREVER. Two big reads in one round: the history is
 * three messages, `compact` returned it untouched, the request got a 400 and
 * the same history was sent again on every later turn of the session.
 */
describe("quando la coda e' il peso", () => {
  const twoBigReads: AgentMessage[] = [
    { role: "user", content: "leggi tutto" },
    { role: "assistant", content: [
      { type: "tool_use", id: "a", name: "read_file", input: { path: "a" } },
      { type: "tool_use", id: "b", name: "read_file", input: { path: "b" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "a", content: "a".repeat(400_000) },
      { type: "tool_result", tool_use_id: "b", content: "b".repeat(400_000) },
    ] },
  ];

  test("una storia corta con risultati enormi viene alleggerita in coda, non lasciata al 400", () => {
    expect(needsCompaction(twoBigReads, 200_000)).toBe(true);
    const r = compact(twoBigReads, { windowTokens: 200_000 });
    expect(r.after).toBeLessThan(r.before);
    expect(needsCompaction(r.messages, 200_000)).toBe(false);
    // The pairing survives, and the model is told how to read the rest.
    const results = r.messages[2]!.content as Block[];
    expect(results.map((b) => b.tool_use_id)).toEqual(["a", "b"]);
    for (const b of results) expect(String(b.content)).toContain("offset/limit");
  });

  test("la richiesta iniziale resta intatta anche in questo ramo", () => {
    const r = compact(twoBigReads, { windowTokens: 200_000 });
    expect(r.messages[0]).toEqual(twoBigReads[0]!);
  });

  test("se alleggerire il mezzo basta, la coda non si tocca", () => {
    const h = longHistory(40, 5000);
    const r = compact(h, { windowTokens: 200_000 });
    expect(r.messages.slice(-6)).toEqual(h.slice(-6));
  });

  test("il prompt di sistema e gli schemi dei tool contano nella stessa finestra", () => {
    const h = longHistory(10, 20_000); // ~50k tokens of messages
    expect(needsCompaction(h, 200_000)).toBe(false);
    // With 500k chars of overhead (a mounted fleet) the same history is over.
    expect(needsCompaction(h, 200_000, 500_000)).toBe(true);
    expect(estimateTokens(h, 400)).toBe(estimateTokens(h) + 100);
  });
});

describe("clipToolResult", () => {
  test("sotto il budget torna identico", () => {
    expect(clipToolResult("corto", 10, 5)).toBe("corto");
  });
  test("sopra, tiene testa e coda e dice quanto manca", () => {
    const out = clipToolResult("H".repeat(100) + "M".repeat(1000) + "T".repeat(50), 100, 50);
    expect(out.startsWith("H".repeat(100))).toBe(true);
    expect(out.endsWith("T".repeat(50))).toBe(true);
    expect(out).toContain("1000 chars omitted");
    expect(out).not.toContain("M");
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

/**
 * ── A FULL CONTEXT DOES NOT KILL THE CHAT (card 18bdf214) ────────────────────
 *
 * Two topics on the native runtime went mute for hours: every send came back
 * `prompt is too long: 1000176 tokens > 1000000 maximum`. The compaction had
 * NOT been skipped: `compaction_markers` keeps its receipt, `pre=1115713 →
 * post=480494`. The request it produced was still twice the ceiling. Two
 * defects, and these tests hold both of them still.
 */
describe("il contesto pieno non uccide la chat", () => {
  /** A round with a heavy argument: a `write_file` with the file inside. */
  function writes(rounds: number, argSize: number): AgentMessage[] {
    const msgs: AgentMessage[] = [{ role: "user", content: "Scrivi i file." }];
    for (let i = 0; i < rounds; i++) {
      msgs.push({
        role: "assistant",
        content: [
          { type: "tool_use", id: `w${i}`, name: "write_file", input: { path: `f${i}.ts`, content: "x".repeat(argSize) } },
        ],
      });
      msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `w${i}`, content: "ok" }] });
    }
    return msgs;
  }

  test("gli ARGOMENTI dei tool vecchi si alleggeriscono, non solo i risultati", () => {
    // RED BEFORE: only `tool_result` blocks were emptied. Here the results
    // weigh two characters and all the weight is in the arguments, which used
    // to stay whole: on the two dead topics they were 77% of what was left
    // AFTER compaction.
    const h = writes(40, 20_000);
    const c = compact(h, { windowTokens: 200_000, overheadChars: 0 });
    expect(c.after).toBeLessThan(c.before / 4);
  });

  test("l'argomento alleggerito dice ancora QUALE file era, e quanto manca", () => {
    const c = compact(writes(40, 20_000), { windowTokens: 200_000 });
    const block = c.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === "tool_use" && (b.input as Record<string, unknown>)?.path === "f0.ts");
    const input = block?.input as Record<string, string>;
    expect(input.path).toBe("f0.ts");            // the path is short: it survives whole
    expect(input.content.length).toBeLessThan(400); // the content does not
    expect(input.content).toContain("dropped to fit the context window");
  });

  test("con un bersaglio, la compattazione ci ARRIVA: i turni più vecchi si tagliano", () => {
    // RED BEFORE: lightening has a floor, and the floor can sit above the
    // ceiling. Exactly the measured case: `post=480494` declared, 1,000,176
    // counted by the API, and the chat dead for good. Now the recent tail
    // stays and the rest is cut until it fits.
    // Many rounds, each one light: lightening cannot help because the weight
    // is not INSIDE the messages, it is in their NUMBER. That is the floor.
    const h = writes(2_000, 500);
    const c = compact(h, { windowTokens: 40_000, overheadChars: 0 });
    expect(c.after).toBeLessThanOrEqual(40_000 * 0.75);
    expect(c.droppedMessages).toBeGreaterThan(0);
  });

  test("anche tagliando, la richiesta iniziale resta e dice cosa è sparito", () => {
    const h = writes(2_000, 500);
    const c = compact(h, { windowTokens: 10_000, overheadChars: 0 });
    const testa = c.messages[0]!;
    expect(testa.role).toBe("user");
    expect(String(testa.content)).toContain("Scrivi i file.");
    expect(String(testa.content)).toContain("were removed to fit the context window");
  });

  test("dopo il taglio ogni richiesta di strumento ha ancora la sua risposta", () => {
    // The invariant that would turn the cure into a fault: a `tool_use`
    // without its `tool_result` gets the WHOLE request refused.
    const c = compact(writes(2_000, 500), { windowTokens: 10_000 });
    const asked = new Set<string>();
    const answered = new Set<string>();
    for (const m of c.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === "tool_use" && b.id) asked.add(b.id);
        if (b.type === "tool_result" && b.tool_use_id) answered.add(b.tool_use_id);
      }
    }
    expect([...asked].filter((id) => !answered.has(id))).toEqual([]);
    // And the alternation holds: after the initial request comes an assistant.
    expect(c.messages[1]!.role).toBe("assistant");
  });
});

describe("la stima si CALIBRA, non si assume", () => {
  test("quattro caratteri per token è un'assunzione, e sbagliava di 2x", () => {
    // The number measured on the real case: 1,921,976 characters counted by
    // us, 1,000,176 tokens counted by the API. With the assumed 4 the same
    // history looked like it sat comfortably inside a million.
    const measured = charsPerTokenFrom(1_921_976, 1_000_176);
    expect(measured).toBeCloseTo(1.92, 1);
    const h = longHistory(40, 10_000);
    expect(estimateTokens(h, 0, measured)).toBeGreaterThan(estimateTokens(h) * 1.9);
  });

  test("la calibrazione non è mai più generosa dell'assunzione", () => {
    // Sparse prose would give 5 characters per token, that is "there is more
    // room than I thought": being generous about the room left is EXACTLY the
    // mistake that killed those two chats. It goes down, never up.
    expect(charsPerTokenFrom(5_000, 1_000)).toBe(4);
    expect(charsPerTokenFrom(1_900, 1_000)).toBeCloseTo(1.9, 5);
  });

  test("numeri assurdi non rompono la stima", () => {
    expect(charsPerTokenFrom(0, 100)).toBe(4);
    expect(charsPerTokenFrom(100, 0)).toBe(4);
    expect(charsPerTokenFrom(NaN, 10)).toBe(4);
  });

  test("la soglia scatta con la stima calibrata dove col 4 assunto taceva", () => {
    // RED BEFORE: the defect in one line. The same history, the same window:
    // with the assumed ratio "it fits", with the measured one it does not.
    const h = longHistory(60, 10_000);
    expect(needsCompaction(h, 400_000)).toBe(false);
    expect(needsCompaction(h, 400_000, 0, 1.92)).toBe(true);
  });

  test("un risultato fatto di BLOCCHI pesa: prima contava zero", () => {
    // A `tool_result` with structured content (a screenshot, a block result)
    // was not a string, so it was not counted at all. What we do not count the
    // API counts anyway.
    const h: AgentMessage[] = [{
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "z".repeat(8_000) }] as never }],
    }];
    expect(estimateChars(h)).toBeGreaterThan(8_000);
  });
});

describe("il 400 dell'API porta con sé la misura", () => {
  test("si legge il conteggio vero dal messaggio d'errore", () => {
    // The exact line that came from the two dead topics.
    expect(promptTooLong('prompt is too long: 1000176 tokens > 1000000 maximum'))
      .toEqual({ tokens: 1_000_176, max: 1_000_000 });
  });

  test("dentro il JSON completo dell'errore, come arriva davvero", () => {
    const realMessage = 'API 400: {"type":"error","error":{"type":"invalid_request_error",'
      + '"message":"prompt is too long: 1073758 tokens > 1000000 maximum"}}';
    expect(promptTooLong(realMessage)).toEqual({ tokens: 1_073_758, max: 1_000_000 });
  });

  test("un altro 400 non viene scambiato per contesto pieno", () => {
    expect(promptTooLong("API 400: `tool_use` ids were found without `tool_result` blocks")).toBeNull();
    expect(promptTooLong("API 529: overloaded")).toBeNull();
  });
});
