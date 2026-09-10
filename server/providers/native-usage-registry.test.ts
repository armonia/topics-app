/**
 * IL COSTO DI UNA CARD LAVORATA DAL RUNTIME NATIVO.
 *
 * ── Il guasto ───────────────────────────────────────────────────────────────
 * `getSessionUsage` legge i transcript JSONL di Claude Code. Il nativo gira in
 * processo e non ne scrive: il lettore cercava un file inesistente e rispondeva
 * zero. Misurato il 18/08 sul DB vivo: 43 card con `agent_ms > 0` e
 * `agent_tokens = 0` — tutte quelle lavorate dal nativo, cioe' da li' in avanti
 * tutte. Segnalato con queste parole: «su alcuni task non vedo riportato il
 * consumo token».
 *
 * Il numero c'era gia' (`runAgentTurn` lo misura e lo restituisce); a mancare
 * era il posto dove depositarlo. Cio' che questi casi sorvegliano non e' la
 * somma — e' banale — ma le tre scelte che la rendono utilizzabile.
 * @covers USAGE-03, USAGE-04
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { recordTurnUsage, readNativeUsage, resetNativeUsage, listNativeUsage } from "./native-usage-registry";

const turno = (o: Partial<Parameters<typeof recordTurnUsage>[1]> = {}) => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...o,
});

describe("il registro dell'uso del runtime nativo", () => {
  beforeEach(() => resetNativeUsage());

  test("una sessione mai vista risponde null, NON zero", () => {
    // E' la scelta che tiene in piedi il ripiego: `null` = «non lo so», e chi
    // chiama cade sul lettore dei transcript per le sessioni CLI. Uno zero
    // direbbe «misurato: non ha consumato niente» e spegnerebbe quel ripiego,
    // rimettendo a zero il costo di ogni card lavorata dalla CLI.
    expect(readNativeUsage("topic:mai-vista")).toBeNull();
  });

  test("i turni si SOMMANO: la card porta il totale della sessione, non l'ultimo turno", () => {
    recordTurnUsage("s1", turno({ input: 100, output: 20 }));
    recordTurnUsage("s1", turno({ input: 50, output: 5 }));
    const u = readNativeUsage("s1")!;
    expect(u.inputTokens).toBe(150);
    expect(u.outputTokens).toBe(25);
  });

  test("leggere NON consuma: il ticker rilegge ogni quattro secondi", () => {
    // E' la differenza con `turn-end-registry`, che consuma apposta. Qui un
    // registro che consumasse darebbe zero alla seconda lettura e il contatore
    // della board crollerebbe a meta' turno.
    recordTurnUsage("s1", turno({ input: 100 }));
    expect(readNativeUsage("s1")!.inputTokens).toBe(100);
    expect(readNativeUsage("s1")!.inputTokens).toBe(100);
    expect(readNativeUsage("s1")!.inputTokens).toBe(100);
  });

  test("`billableTokens` e' input+output+cacheWrite, e cacheRead resta fuori", () => {
    // La semantica storica del lettore dei transcript: divergere qui vorrebbe
    // dire due unita' di misura sulla stessa colonna della board, e il chip non
    // sarebbe piu' confrontabile turno su turno.
    recordTurnUsage("s1", turno({ input: 10, output: 3, cacheWrite: 7, cacheRead: 1000 }));
    const u = readNativeUsage("s1")!;
    expect(u.billableTokens).toBe(20);
    expect(u.cacheReadTokens).toBe(1000);
  });

  test("la quota a un'ora e' un SOTTOINSIEME di cacheWrite, non un addendo", () => {
    // Costa 2x invece di 1.25x e sta nell'usage (`ephemeral_1h_input_tokens`).
    // Sommarla a `cacheWrite` gonfierebbe il conto del doppio su quella quota.
    recordTurnUsage("s1", turno({ cacheWrite: 100, cacheWrite1h: 100 }));
    const u = readNativeUsage("s1")!;
    expect(u.cacheWriteTokens).toBe(100);
    expect(u.cacheWrite1hTokens).toBe(100);
    expect(u.billableTokens).toBe(100);
  });

  test("le sessioni non si mescolano", () => {
    recordTurnUsage("s1", turno({ input: 10 }));
    recordTurnUsage("s2", turno({ input: 999 }));
    expect(readNativeUsage("s1")!.inputTokens).toBe(10);
    expect(readNativeUsage("s2")!.inputTokens).toBe(999);
  });

  test("una chiave vuota non crea una voce fantasma", () => {
    recordTurnUsage("", turno({ input: 10 }));
    expect(readNativeUsage("")).toBeNull();
  });

  test("il tetto sfratta la sessione ferma da piu' tempo, non quella viva", () => {
    // Le sessioni di chat non vengono mai ritirate: senza tetto la mappa
    // crescerebbe di una riga per ogni chat mai piu' riaperta. Ma lo sfratto
    // deve colpire la piu' vecchia — buttare la sessione ATTIVA azzererebbe il
    // contatore di una card mentre la si guarda.
    for (let i = 0; i < 205; i++) recordTurnUsage(`s${i}`, turno({ input: 1 }));
    // `s0` e' la piu' vecchia e non c'e' piu'; le ultime ci sono tutte.
    expect(readNativeUsage("s0")).toBeNull();
    expect(readNativeUsage("s204")).not.toBeNull();
  });

  test("una sessione toccata di recente NON viene sfrattata, anche se nata prima", () => {
    // Il `delete+set` serve a questo: rimette la chiave in coda all'ordine
    // d'inserimento. Senza, lo sfratto guarderebbe la data di NASCITA e
    // butterebbe via la sessione piu' vecchia anche se e' quella al lavoro.
    recordTurnUsage("vecchia-ma-viva", turno({ input: 1 }));
    for (let i = 0; i < 100; i++) recordTurnUsage(`x${i}`, turno({ input: 1 }));
    recordTurnUsage("vecchia-ma-viva", turno({ input: 1 })); // torna in coda
    for (let i = 100; i < 204; i++) recordTurnUsage(`x${i}`, turno({ input: 1 }));
    expect(readNativeUsage("vecchia-ma-viva")).not.toBeNull();
  });
  test("listNativeUsage answers for N sessions with one call, keeping the same numbers", () => {
    // The route this feeds is a LIST endpoint: asking per session would be one
    // round trip each for a map that is already in memory. The per-key reader
    // stays the authority, so the two must never disagree.
    recordTurnUsage("a", turno({ input: 10, output: 3, cacheRead: 7, cacheWrite: 5 }));
    recordTurnUsage("b", turno({ input: 1 }));
    const list = listNativeUsage();
    expect(list.map((e) => e.sessionKey).sort()).toEqual(["a", "b"]);
    const a = list.find((e) => e.sessionKey === "a")!;
    expect(a.inputTokens).toBe(10);
    expect(a.outputTokens).toBe(3);
    expect(a.cacheReadTokens).toBe(7);
    expect(a.billableTokens).toBe(readNativeUsage("a")!.billableTokens);
  });

  test("an EVICTED session is absent from the list, never present with zeros", () => {
    // The whole contract of the endpoint. A zero row would read "measured: it
    // cost nothing", which about a session that was pushed off the end of a
    // 200-entry cap is the opposite of true — and it is exactly the statement
    // `readNativeUsage` refuses to make by returning null.
    for (let i = 0; i < 205; i++) recordTurnUsage(`s${i}`, turno({ input: 1 }));
    const keys = new Set(listNativeUsage().map((e) => e.sessionKey));
    expect(keys.has("s0")).toBe(false);
    expect(keys.has("s204")).toBe(true);
    expect(keys.size).toBe(200);
  });

  test("an empty registry is an empty list, not a list of zeros", () => {
    expect(listNativeUsage()).toEqual([]);
  });
});
