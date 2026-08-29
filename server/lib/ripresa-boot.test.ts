/**
 * Le prove di `ripresa-boot.ts`.
 *
 * Il «sì» è uno. I «no» sono cinque, e sono la ragione per cui questa macchina
 * si può accendere: ogni ripresa sbagliata è un turno vero, a pagamento, e in
 * un ciclo sono tutti.
 *
 * @covers RESUME-01, RESUME-03
 */
import { describe, expect, test } from "bun:test";
import {
  chatDaRiprendere, FINESTRA_RIPRESA_MS, riprendiTurniInterrotti,
  RESPONSE_CEILING_MS, STREAM_CEILING_MS, type RigaDaValutare,
} from "./ripresa-boot";
import { Database } from "bun:sqlite";
import { insertRestartNotification } from "./boot-partial-sweep";
import { decodeCol } from "../../shared/message-blob";
import type { ContentBlock } from "../types";

const ORA = Date.UTC(2026, 7, 20, 21, 0, 0);
const interrotto: ContentBlock = { kind: "error", text: "Turno interrotto: il server si è riavviato." };
const prosa: ContentBlock = { kind: "text", text: "stavo misurando" };

const base: RigaDaValutare = {
  sessionKey: "topic:9f9e9629",
  ruolo: "assistant",
  blocks: [prosa, interrotto],
  timestampMs: ORA - 60_000,
};

describe("quale chat riprende da sola", () => {
  test("ultimo turno interrotto, poco fa: si riprende", () => {
    expect(chatDaRiprendere(base, ORA)).toBe(true);
  });

  test("l'ultima parola è dell'utente: ha ripreso lui", () => {
    // Ha riscritto nel frattempo. Rimandare il suo messaggio vecchio gli
    // farebbe rispondere due volte, di cui una a una domanda superata.
    expect(chatDaRiprendere({ ...base, ruolo: "user" }, ORA)).toBe(false);
  });

  test("nessun verdetto di interruzione: il turno è finito bene, o l'ha fermato lui", () => {
    // `cancelledNotice` tace su `user`, quindi un turno fermato a mano NON ha
    // il blocco `error`: questo controllo è anche il modo in cui il suo Ferma
    // viene rispettato.
    expect(chatDaRiprendere({ ...base, blocks: [prosa] }, ORA)).toBe(false);
  });

  test("già ripreso: mai due volte", () => {
    const b = [...base.blocks!, { kind: "ripreso" } as ContentBlock];
    expect(chatDaRiprendere({ ...base, blocks: b }, ORA)).toBe(false);
  });

  test("fuori finestra: non si risponde a una domanda di ieri", () => {
    expect(chatDaRiprendere({ ...base, timestampMs: ORA - FINESTRA_RIPRESA_MS - 1 }, ORA)).toBe(false);
    // Al bordo interno si riprende ancora.
    expect(chatDaRiprendere({ ...base, timestampMs: ORA - FINESTRA_RIPRESA_MS + 1 }, ORA)).toBe(true);
  });

  test("senza blocchi non si decide niente", () => {
    expect(chatDaRiprendere({ ...base, blocks: [] }, ORA)).toBe(false);
    expect(chatDaRiprendere({ ...base, blocks: null }, ORA)).toBe(false);
  });
});

/**
 * NON OGNI BLOCCO `error` È UN'INTERRUZIONE NOSTRA.
 *
 * Il cancello era `blocks.some(b => b.kind === "error")`: qualunque verdetto di
 * guasto. Ma in quel blocco ci finisce TUTTO ciò che va storto, e sul database
 * vivo gli ultimi messaggi con un blocco `error` erano 25 «ai-bridge: ack
 * timeout», 4 «Process exited with code», 1 «API 400».
 *
 * Nessuno di quelli è un turno da riprendere: sono guasti deterministici, e
 * rimandare il messaggio ricompra lo stesso fallimento — su un turno lungo
 * riaprendo tutti i giri di tool già fatti. I test di questo file non li
 * coprivano: passavano perché la loro fixture usa già il testo del cartello
 * giusto, cioè per fortuna e non per costruzione.
 */
describe("i guasti che NON sono un'interruzione", () => {
  const withError = (text: string): RigaDaValutare => ({
    ...base,
    blocks: [prosa, { kind: "error", text } as ContentBlock],
  });

  test("i testi VERI presi dal database non fanno scattare la ripresa", () => {
    for (const guasto of [
      "ai-bridge: ack timeout (list, 5s)",
      "ai-bridge: ack timeout (spawn topic:f4841e2f, 20s)",
      "Process exited with code 1",
      "API 400",
      "Nessuna risposta: il turno si è chiuso senza produrre niente.",
    ]) {
      expect(chatDaRiprendere(withError(guasto), ORA), guasto).toBe(false);
    }
  });

  test("e il cartello di interruzione continua a farla scattare", () => {
    expect(chatDaRiprendere(base, ORA)).toBe(true);
    for (const c of [
      "Turno interrotto: il processo dell'agente non dava più segni di vita e la risposta è stata chiusa.",
      "Turno interrotto: ha superato il limite di tempo concesso.",
    ]) {
      expect(chatDaRiprendere(withError(c), ORA), c).toBe(true);
    }
  });

  /**
   * L'annullamento SENZA causa dichiarata prende un cartello ma non si
   * riprende: non si indovina chi ha annullato. Stessa regola di
   * `meritaRipresaAutomatica`.
   */
  test("il cartello generico non basta", () => {
    expect(chatDaRiprendere(withError("Turno interrotto prima della fine."), ORA)).toBe(false);
  });
});


/**
 * THE SEAM, which is the part nobody tested.
 *
 * Both halves had a test, each with its own fake row: on one side "the boot
 * writes the notice", on the other "a notice shaped like this deserves the
 * resume". In between nobody asked whether the notice the boot ACTUALLY writes
 * is one of those. It was not, for two independent reasons: the row was born
 * with no blocks (and the rule bails immediately - it has a test called "no
 * blocks, no decision"), and the two sentences did not match either. The one it
 * wrote and the one the list recognised are quoted in the assertion below, and
 * they are the subject here, not prose:
 *   written:    "Turno interrotto DA un riavvio del server"  allow-italian: it is the notice text itself
 *   recognised: "Turno interrotto: il server si e' riavviato"  allow-italian: it is the notice text itself
 *
 * The cost, read in the chat on 2026-08-28: "now it gives me turn interrupted
 * by a restart", and no resume. The mechanism existed, was switched on, and
 * could not fire.
 */
describe("the notice the boot ACTUALLY writes is resumed", () => {
  function noticeWrittenByBoot(): { blocks: unknown; timestampMs: number } {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT,
      partial INTEGER, timestamp TEXT, sort_order INTEGER, parent_id TEXT, branch_index INTEGER
    )`);
    db.run(
      "INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, branch_index) VALUES ('m1','topic:x','user','ciao',0,'2026-08-28T20:00:00.000Z',0,0)",
    );
    insertRestartNotification(
      db as unknown as Parameters<typeof insertRestartNotification>[0],
      "topic:x",
      { generateId: () => "avviso", now: () => "2026-08-28T20:01:00.000Z" },
    );
    const row = db.query("SELECT blocks, timestamp FROM messages WHERE id = 'avviso'").get() as
      { blocks?: unknown; timestamp: string };
    const raw = decodeCol(row.blocks);
    return {
      blocks: raw ? JSON.parse(raw) : null,
      timestampMs: Date.parse(row.timestamp),
    };
  }

  test("it carries the verdict, and the resume recognises it", () => {
    const { blocks, timestampMs } = noticeWrittenByBoot();
    const row: RigaDaValutare = {
      sessionKey: "topic:x",
      ruolo: "assistant",
      blocks: blocks as ContentBlock[] | null,
      timestampMs,
    };
    expect(chatDaRiprendere(row, timestampMs + 60_000)).toBe(true);
  });
});

/**
 * THE RESUME MUST COME BACK, even when the route does not.
 *
 * Measured on 2026-08-29 (topic:0299ac2d): the boot printed "1 turno/i  allow-italian: quoted log line
 * interrotto/i da riprendere" and then, for 488 lines to the end of the file,  allow-italian: quoted log line
 * nothing about that session. Not the success line, not the refusal line, and
 * not even `[HTTP] POST /api/chat received`, which is the first statement of
 * the chat handler and runs before any await. So `await router(...)` had not
 * returned and never would: the resume, and with it the last link of the boot
 * chain, stopped there in silence.
 *
 * These two tests are that failure, reproduced in a second: a route that never
 * answers, and a route that answers and then never closes the stream. Before
 * the ceilings they would both hang forever, which is exactly the bug. What is
 * asserted is not "it goes fast" but three facts: the function RETURNS, it
 * SAYS in the log where it gave up, and the trace is already written so the
 * next boot does not resend the same turn a second time.
 *
 * @covers RESUME-01
 */
describe("una route che non risponde non pianta il boot", () => {
  const nowIso = () => new Date().toISOString();

  function dbWithCutTurn(): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT,
      partial INTEGER, timestamp TEXT, sort_order INTEGER, parent_id TEXT, branch_index INTEGER
    )`);
    db.run(
      "INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, branch_index) VALUES ('m1','topic:x','user','misura la ripresa',0,?,0,0)",
      [nowIso()],
    );
    insertRestartNotification(
      db as unknown as Parameters<typeof insertRestartNotification>[0],
      "topic:x",
      { generateId: () => "avviso", now: nowIso },
    );
    return db;
  }

  const ctxOf = (db: Database): Parameters<typeof riprendiTurniInterrotti>[0] => ({ db, getTopicBySessionKey: () => ({ archived: false }) });

  /** Runs the resume against a ceiling of its own: a test that can hang is the
   *  same silence it is meant to catch, so the wait is bounded here too. */
  async function withinTwoSeconds(work: Promise<void>): Promise<"done" | "hung"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alarm = new Promise<"hung">((r) => { timer = setTimeout(() => r("hung"), 2_000); });
    try { return await Promise.race([work.then(() => "done" as const), alarm]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  /** Runs `work` with `console.warn` captured, and hands back BOTH what it
   *  returned and what it said: the log line is half the claim here. */
  async function withWarn<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
    const said: string[] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
    try { return { result: await work(), lines: said }; } finally { console.warn = real; }
  }

  test("il router che non risponde mai: la funzione torna e lo dice", async () => {
    const db = dbWithCutTurn();
    const { result: outcome, lines } = await withWarn(() => withinTwoSeconds(
      riprendiTurniInterrotti(ctxOf(db), () => new Promise<Response>(() => { /* never */ }), { responseMs: 60 }),
    ));
    expect(outcome).toBe("done");
    expect(lines.join("\n")).toContain("topic:x");
    expect(lines.join("\n")).toContain("non ha risposto");
    // The trace is there anyway: the next boot does not resend this turn.
    const after = db.query("SELECT blocks FROM messages WHERE id = 'avviso'").get() as { blocks?: unknown };
    const blocks = JSON.parse(decodeCol(after.blocks) ?? "[]") as ContentBlock[];
    expect(blocks.some((b) => b?.kind === "ripreso")).toBe(true);
  });

  test("lo stream che non finisce mai: stesso stop, un passo più in là", async () => {
    const db = dbWithCutTurn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: {}\n\n")); },
      // no close(): the route answered, the turn never ends
    });
    const { result: outcome, lines } = await withWarn(() => withinTwoSeconds(
      riprendiTurniInterrotti(
        ctxOf(db),
        () => new Response(body, { status: 200 }),
        { responseMs: 500, streamMs: 60 },
      ),
    ));
    expect(outcome).toBe("done");
    expect(lines.join("\n")).toContain("non è finito entro");
  });

  test("i tetti di produzione sono minuti, non secondi", () => {
    // A tight ceiling would kill the real resumes: the response is headers,
    // the stream is the whole turn.
    expect(RESPONSE_CEILING_MS).toBeGreaterThanOrEqual(30_000);
    expect(STREAM_CEILING_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
