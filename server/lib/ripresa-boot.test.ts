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
  chatDaRiprendere, FINESTRA_RIPRESA_MS, MAX_RESUME_ATTEMPTS, riprendiTurniInterrotti,
  RESPONSE_CEILING_MS, STREAM_CEILING_MS, RESUME_CAP_MARKER, attemptsInChain, attemptsOnRow,
  resumeVerdict, type RigaDaValutare,
} from "./ripresa-boot";
import { Database } from "bun:sqlite";
import { insertRestartNotification } from "./boot-partial-sweep";
import { eCartelloDiInterruzione } from "./cancelled-notice";
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
  attempts: 0,
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

  test("già ripreso: si CONTA sulla catena, non è un interruttore", () => {
    // The trace is written BEFORE the resend, on purpose: written after, a
    // resend that dies halfway would be retried forever. As a switch, though,
    // that price was paid on the first try, and a resend that got CUT - the
    // server restarting while the resumed turn was running - burned the single
    // chance. From then on every boot skipped that row, under a notice
    // promising it would resume on its own. Measured on 2026-08-29 on
    // topic:0299ac2d, reported four times.
    //
    // The count is the CHAIN's, handed in by the caller: one cut attempt does
    // not close the door, the cap does, and past the cap the verdict is not a
    // silent "no" but "capped", which the loop turns into a notice in the chat.
    expect(chatDaRiprendere({ ...base, attempts: 1 }, ORA)).toBe(true);
    expect(resumeVerdict({ ...base, attempts: MAX_RESUME_ATTEMPTS }, ORA)).toBe("capped");
    expect(resumeVerdict({ ...base, attempts: MAX_RESUME_ATTEMPTS + 5 }, ORA)).toBe("capped");
    // "capped" is only for rows that DESERVED the resend: a row with no
    // interruption of ours past the cap is a plain "no", nothing gets written.
    expect(resumeVerdict({ ...base, blocks: [prosa], attempts: MAX_RESUME_ATTEMPTS }, ORA)).toBe("no");
    expect(resumeVerdict({ ...base, ruolo: "user", attempts: MAX_RESUME_ATTEMPTS }, ORA)).toBe("no");
  });

  test("il cartello del tetto non e' un'interruzione: il boot dopo non lo riprende", () => {
    // Written with the same ⚠️ shape the client renders as "Riprova", it would  allow-italian: button label
    // be the perfect fuel for the loop it closes if the recogniser took it.
    expect(RESUME_CAP_MARKER.startsWith("⚠️")).toBe(true);
    expect(eCartelloDiInterruzione(RESUME_CAP_MARKER)).toBe(false);
    expect(chatDaRiprendere({ ...base, blocks: [{ kind: "error", text: RESUME_CAP_MARKER }] }, ORA)).toBe(false);
  });

  test("il numero del tentativo si legge dai blocchi, e le righe vecchie valgono uno", () => {
    expect(attemptsOnRow([prosa, interrotto])).toBe(0);
    expect(attemptsOnRow([prosa, interrotto, { kind: "ripreso" }])).toBe(1);
    expect(attemptsOnRow([{ kind: "ripreso", attempt: 2 }, prosa])).toBe(2);
    expect(attemptsOnRow([{ kind: "ripreso", attempt: 1 }, interrotto, { kind: "ripreso", attempt: 2 }])).toBe(2);
    expect(attemptsOnRow(null)).toBe(0);
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
      attempts: 0,
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

/**
 * THE CHAIN, which the per-row counter could not see.
 *
 * The cap counted `ripreso` blocks on ONE row. But a resumed turn that gets
 * cut by the NEXT restart is a NEW row (the resend's answer), and the boot
 * notice that explains it is a newer row still: every link starts from zero,
 * and MAX_RESUME_ATTEMPTS is never reached. Read on the live DB, topic:6b9605e5,
 * 2026-09-02 between 08:46 and 09:27: the same message resent FIVE times, each
 * answer redoing every tool round from scratch, five "ripreso" banners in the  allow-italian: block name
 * chat, and every resumed turn holding the next restart.
 *
 * Three boots, one message. Boot 1 kills the turn and resumes it. Boot 2 kills
 * the resumed turn and resumes it once more: that is the one automatic retry.
 * Boot 3 kills it again and STOPS, and it says so in the chat, with the same
 * notice shape restart-interrupted turns already get (⚠️ + "Riprova").  allow-italian: button label
 *
 * @covers RESUME-01
 */
describe("la catena dei riavvii ha un tetto", () => {
  const MESSAGE = "misura la catena";

  function freshDb(): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT,
      partial INTEGER, timestamp TEXT, sort_order INTEGER, parent_id TEXT, branch_index INTEGER
    )`);
    db.run(
      "INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, branch_index) VALUES ('u0','topic:x','user',?,0,?,0,0)",
      [MESSAGE, new Date().toISOString()],
    );
    return db;
  }

  const lastRow = (db: Database) => db.query(
    "SELECT id, role, content, blocks FROM messages WHERE session_key = 'topic:x' ORDER BY sort_order DESC, rowid DESC LIMIT 1",
  ).get() as { id: string; role: string; content: string; blocks: unknown };
  const blocksOf = (raw: unknown) => JSON.parse(decodeCol(raw) ?? "[]") as ContentBlock[];

  /** What boot-partial-sweep does when the server comes back and finds the
   *  turn that died with it: the ⚠️ notice, parented to the last row. */
  let notices = 0;
  const serverDiedUnderTheTurn = (db: Database) => insertRestartNotification(
    db as unknown as Parameters<typeof insertRestartNotification>[0],
    "topic:x",
    { generateId: () => `notice-${++notices}`, now: () => new Date().toISOString() },
  );

  /** The chat route, as far as the resume can see it: it deposits the resent
   *  user message and an answer carrying the same banner `chat.ts` pushes,
   *  then returns a stream that closes. The answer will be "cut" by the test
   *  calling `serverDiedUnderTheTurn` afterwards. */
  function chatRoute(db: Database, calls: Array<Record<string, unknown>>): Parameters<typeof riprendiTurniInterrotti>[1] {
    return async (req) => {
      const body = await req.json() as Record<string, unknown>;
      calls.push(body);
      const n = calls.length;
      const parent = lastRow(db);
      const order = (db.query("SELECT COALESCE(MAX(sort_order), -1) AS mo FROM messages").get() as { mo: number }).mo;
      db.run(
        "INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, parent_id, branch_index) VALUES (?,?,'user',?,0,?,?,?,0)",
        [`u${n}`, "topic:x", MESSAGE, new Date().toISOString(), order + 1, parent.id],
      );
      const banner: ContentBlock = typeof body.ripresa === "number"
        ? ({ kind: "ripreso", attempt: body.ripresa } as ContentBlock)
        : { kind: "ripreso" };
      db.run(
        "INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order, parent_id, branch_index) VALUES (?,?,'assistant','',?,0,?,?,?,0)",
        [`a${n}`, "topic:x", JSON.stringify([banner, { kind: "tool", toolCall: { id: "t", name: "Bash", args: {}, status: "success" } }]), new Date().toISOString(), order + 2, `u${n}`],
      );
      return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
    };
  }

  const ctxOf = (db: Database): Parameters<typeof riprendiTurniInterrotti>[0] => ({ db, getTopicBySessionKey: () => ({ archived: false }) });
  const quietly = async (work: () => Promise<void>) => {
    const log = console.log, warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try { await work(); } finally { console.log = log; console.warn = warn; }
  };

  test("tre boot di fila: ripreso, ripreso una seconda volta, poi fermo e detto in chat", async () => {
    const db = freshDb();
    const calls: Array<Record<string, unknown>> = [];
    const route = chatRoute(db, calls);

    // Boot 1: the turn died with the server, the notice is written, the resume fires.
    serverDiedUnderTheTurn(db);
    await quietly(() => riprendiTurniInterrotti(ctxOf(db), route, { responseMs: 500, streamMs: 500 }));
    expect(calls.length).toBe(1);
    expect(calls[0].ripresa).toBe(1);

    // Boot 2: the RESUMED turn died with the server. One automatic retry.
    serverDiedUnderTheTurn(db);
    await quietly(() => riprendiTurniInterrotti(ctxOf(db), route, { responseMs: 500, streamMs: 500 }));
    expect(calls.length).toBe(2);
    expect(calls[1].ripresa).toBe(2);

    // Boot 3: cut again. The chain has spent MAX_RESUME_ATTEMPTS: no resend...
    serverDiedUnderTheTurn(db);
    await quietly(() => riprendiTurniInterrotti(ctxOf(db), route, { responseMs: 500, streamMs: 500 }));
    expect(calls.length).toBe(MAX_RESUME_ATTEMPTS);
    // ...and the chat SAYS so, in the shape the client already renders as an
    // amber banner with the "Riprova" button: ⚠️ prefix, error block only.  allow-italian: button label
    const cap = lastRow(db);
    expect(cap.role).toBe("assistant");
    expect(cap.content.startsWith("⚠️")).toBe(true);
    expect(cap.content).toContain("Riprova");
    const capBlocks = blocksOf(cap.blocks);
    expect(capBlocks.length).toBe(1);
    expect(capBlocks[0].kind).toBe("error");

    // Boot 4: the cap notice is the last row. Nothing resumes, nothing is
    // written twice.
    const rowsBefore = (db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
    await quietly(() => riprendiTurniInterrotti(ctxOf(db), route, { responseMs: 500, streamMs: 500 }));
    expect(calls.length).toBe(MAX_RESUME_ATTEMPTS);
    expect((db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(rowsBefore);
  });

  test("il tetto e' due: una ripresa e un solo tentativo in piu'", () => {
    expect(MAX_RESUME_ATTEMPTS).toBe(2);
  });

  /**
   * The walk itself, on the two shapes a cut resend leaves behind.
   *
   * Graceful shutdown writes the verdict ON the cut answer (`avvisoPerTurno`),
   * so the row being judged already carries the banner. A SIGKILL leaves the
   * answer partial, and the next boot's sweep explains it with a NEW notice
   * row that carries nothing: the banner is one hop up. Both must count the
   * same, and a turn the user asked for afresh must count as zero.
   */
  test("la catena si legge lungo parent_id, in entrambe le forme del taglio", () => {
    const db = freshDb();
    const insertRow = (id: string, role: string, blocks: ContentBlock[] | null, parent: string | null) => db.run(
      "INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order, parent_id, branch_index) VALUES (?,?,?,?,?,0,?,?,?,0)",
      [id, "topic:x", role, "", blocks ? JSON.stringify(blocks) : null, new Date().toISOString(), Number(id.replace(/\D/g, "")) || 1, parent],
    );
    const tool = (): ContentBlock => ({ kind: "tool", toolCall: { id: "t", name: "Bash", args: {}, status: "success" } }) as ContentBlock;
    // Boot 1 explained a0 with a notice n0, then resumed (trace #1 on n0).
    insertRow("a0", "assistant", [tool()], "u0");
    insertRow("n0", "assistant", [interrotto, { kind: "ripreso", attempt: 1 }], "a0");
    insertRow("u1", "user", null, "n0");
    // Shape A: the resumed answer, cut gracefully: verdict on the row itself.
    insertRow("a1", "assistant", [{ kind: "ripreso", attempt: 1 }, tool(), interrotto], "u1");
    expect(attemptsInChain(db, "topic:x", "a1")).toBe(1);
    // Boot 2 resumed it (trace #2 on a1), and the answer was SIGKILLed:
    // shape B, the sweep's fresh notice n2 with nothing on it.
    db.run("UPDATE messages SET blocks = ? WHERE id = 'a1'", [JSON.stringify([{ kind: "ripreso", attempt: 1 }, tool(), interrotto, { kind: "ripreso", attempt: 2 }])]);
    insertRow("u2", "user", null, "a1");
    insertRow("a2", "assistant", [{ kind: "ripreso", attempt: 2 }, tool()], "u2");
    insertRow("n2", "assistant", [interrotto], "a2");
    expect(attemptsInChain(db, "topic:x", "n2")).toBe(2);
    // A new message from the user after all that: its own turn, its own chain.
    insertRow("u3", "user", null, "n2");
    insertRow("a3", "assistant", [tool()], "u3");
    insertRow("n3", "assistant", [interrotto], "a3");
    expect(attemptsInChain(db, "topic:x", "n3")).toBe(0);
    // A row nobody has resumed yet, with the very first notice: zero.
    expect(attemptsInChain(db, "topic:x", "a0")).toBe(0);
  });
});

/**
 * TWO CHATS TO RESUME, NOT ONE BEHIND THE OTHER.
 *
 * The resend loop awaited the answer and then DRAINED the stream, which is a
 * whole turn: the second candidate did not start until the first had finished,
 * up to fifteen minutes later, while its chat carried a notice promising it
 * resumes by itself. The same SIGTERM kills them both, so the second one often
 * never started at all (card 6c2dc14c).
 *
 * @covers RESUME-01
 */
describe("i rimandi partono insieme, non in fila", () => {
  const nowIso = () => new Date().toISOString();

  function dbWithTwoCutTurns(): Database {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT,
      partial INTEGER, timestamp TEXT, sort_order INTEGER, parent_id TEXT, branch_index INTEGER
    )`);
    let order = 0;
    for (const sk of ["topic:uno", "topic:due"]) {
      db.run(
        "INSERT INTO messages (id, session_key, role, content, partial, timestamp, sort_order, branch_index) VALUES (?,?,'user','misura la ripresa',0,?,?,0)",
        [`m-${sk}`, sk, nowIso(), order++],
      );
      insertRestartNotification(
        db as unknown as Parameters<typeof insertRestartNotification>[0],
        sk,
        { generateId: () => `avviso-${sk}`, now: nowIso },
      );
    }
    return db;
  }

  test("la seconda POST non aspetta che finisca lo stream della prima", async () => {
    const db = dbWithTwoCutTurns();
    const startedAt: number[] = [];
    // Every resend answers at once and keeps its stream open for 300 ms: in
    // series the second POST could not arrive before then.
    const route: Parameters<typeof riprendiTurniInterrotti>[1] = async () => {
      startedAt.push(Date.now());
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          setTimeout(() => controller.close(), 300);
        },
      });
      return new Response(body, { status: 200 });
    };

    const log = console.log, warn = console.warn;
    console.log = () => {}; console.warn = () => {};
    try {
      await riprendiTurniInterrotti(
        { db, getTopicBySessionKey: () => ({ archived: false }) } as Parameters<typeof riprendiTurniInterrotti>[0],
        route,
        { responseMs: 500, streamMs: 500 },
      );
    } finally { console.log = log; console.warn = warn; }

    expect(startedAt).toHaveLength(2);
    expect(startedAt[1] - startedAt[0]).toBeLessThan(50);
  });
});
