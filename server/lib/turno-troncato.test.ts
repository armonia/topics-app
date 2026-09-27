/**
 * Le prove di `turno-troncato.ts`.
 *
 * Il «sì» è uno: un turno che stava lavorando quando il server è morto. I «no»
 * sono la parte che conta — senza di essi, OGNI chat sana si prenderebbe un
 * «turno interrotto» a ogni riavvio, e il cartello smetterebbe di voler dire
 * qualcosa proprio mentre lo si scrive dappertutto.
 *
 * @covers INTERRUPT-01
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { settleReattachLeg, èTroncato, TURNO_TRONCATO, spiegaTurnoTroncato } from "./turno-troncato";
import type { ContentBlock } from "../types";
import { Database } from "bun:sqlite";
import { decodeCol, encodeCol } from "../../shared/message-blob";

const tool = (): ContentBlock =>
  ({ kind: "tool", toolCall: { id: "t", name: "Bash", args: {}, status: "success" } }) as ContentBlock;
const testo = (t = "ecco fatto"): ContentBlock => ({ kind: "text", text: t });

describe("chi è stato troncato", () => {
  test("finiva su un tool: stava lavorando, quindi è stato tagliato", () => {
    expect(èTroncato("assistant", [testo("sto misurando"), tool()])).toBe(true);
  });

  test("finiva parlando: è il modo normale di finire", () => {
    // Questo è il freno che tiene tutto: senza, ogni chat sana prende un
    // cartello a ogni riavvio del server.
    expect(èTroncato("assistant", [tool(), testo()])).toBe(false);
  });

  test("ha già una spiegazione: non se ne aggiunge una seconda", () => {
    expect(èTroncato("assistant", [tool(), { kind: "error", text: "già spiegato" }])).toBe(false);
  });

  test("non è dell'assistente, o non ha blocchi: non si decide niente", () => {
    expect(èTroncato("user", [tool()])).toBe(false);
    expect(èTroncato("assistant", [])).toBe(false);
    expect(èTroncato("assistant", null)).toBe(false);
  });
});

describe("il cartello finisce davvero sulla riga", () => {
  const dbDiProva = () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, role TEXT, blocks BLOB, sort_order INTEGER)`);
    return db;
  };
  const inserisci = (db: Database, id: string, role: string, blocks: ContentBlock[], ord: number) =>
    db.prepare(`INSERT INTO messages (id, session_key, role, blocks, sort_order) VALUES (?, 'topic:x', ?, ?, ?)`)
      .run(id, role, encodeCol(JSON.stringify(blocks)) ?? null, ord);
  const leggi = (db: Database, id: string) =>
    JSON.parse(decodeCol((db.query(`SELECT blocks FROM messages WHERE id=?`).get(id) as { blocks: unknown }).blocks) ?? "[]") as ContentBlock[];

  test("scrive sull'ULTIMA riga, e solo se serve", () => {
    const db = dbDiProva();
    inserisci(db, "vecchia", "assistant", [tool(), testo()], 0);
    inserisci(db, "ultima", "assistant", [testo("sto misurando"), tool()], 1);

    expect(spiegaTurnoTroncato(db as never, "topic:x")).toBe(true);
    expect(leggi(db, "ultima").at(-1)).toEqual({ kind: "error", text: TURNO_TRONCATO });
    // La riga di prima non si tocca: è finita bene ed è storia.
    expect(leggi(db, "vecchia").some((b) => b.kind === "error")).toBe(false);
  });

  test("ripetibile: alla seconda passata non scrive più", () => {
    const db = dbDiProva();
    inserisci(db, "a", "assistant", [testo("lavoro"), tool()], 0);
    expect(spiegaTurnoTroncato(db as never, "topic:x")).toBe(true);
    expect(spiegaTurnoTroncato(db as never, "topic:x")).toBe(false);
    expect(leggi(db, "a").filter((b) => b.kind === "error")).toHaveLength(1);
  });

  test("una sessione che non esiste non fa esplodere il boot", () => {
    const db = dbDiProva();
    expect(spiegaTurnoTroncato(db as never, "topic:mai-vista")).toBe(false);
  });
});

/**
 * THE END OF A BOOT REATTACH LEG TELLS THE OPEN WINDOWS (card edf3c4db).
 *
 * When the leg is over the broker is asked again. A turn still open (a
 * question on screen) keeps its row live, and nothing is sent: a stray frame
 * would reach windows watching that turn. A turn that is over has its rows
 * closed and the cut explained, and that was written in the database only: a
 * window open on the chat kept the bubble open and unexplained until a reload.
 * The frame is the one that takes the window's read past its history dedup,
 * since at boot every window has just read the chat on reconnect.
 */
describe("the end of a boot reattach leg", () => {
  const withRows = () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, role TEXT, blocks BLOB, sort_order INTEGER, partial INTEGER, streamed_at TEXT)`);
    return db;
  };
  const add = (db: Database, id: string, blocks: ContentBlock[], partial: number) =>
    db.prepare(`INSERT INTO messages (id, session_key, role, blocks, sort_order, partial, streamed_at) VALUES (?, 'topic:x', 'assistant', ?, 0, ?, ?)`)
      .run(id, encodeCol(JSON.stringify(blocks)) ?? null, partial, partial ? new Date().toISOString() : null);
  const rowOf = (db: Database, id: string) => {
    const r = db.query(`SELECT partial, streamed_at, blocks FROM messages WHERE id = ?`).get(id) as { partial: number; streamed_at: string | null; blocks: unknown };
    return { partial: r.partial, streamedAt: r.streamed_at, blocks: JSON.parse(decodeCol(r.blocks) ?? "[]") as ContentBlock[] };
  };
  const ctxOf = (db: Database, frames: unknown[]) => ({
    db: db as never,
    getTopicBySessionKey: () => ({ id: "t-x" }),
    broadcastToAll: (m: unknown) => { frames.push(m); },
  });
  // With the session key: the open pane reconciles by it, and drops a frame without one.
  const THREAD_CHANGED = { type: "topic:updated", topic: { id: "t-x", sessionKey: "topic:x" }, threadChanged: true };

  test("the broker says the turn is over: the row is closed, explained, and the open windows told once", async () => {
    const db = withRows();
    add(db, "cut", [testo("sto misurando"), tool()], 1);
    const frames: unknown[] = [];
    expect(await settleReattachLeg(ctxOf(db, frames), "topic:x", async () => "idle" as const)).toBe(1);
    const row = rowOf(db, "cut");
    expect(row.partial).toBe(0);
    expect(row.streamedAt).toBeNull();
    expect(row.blocks.at(-1)).toEqual({ kind: "error", text: TURNO_TRONCATO });
    expect(frames).toEqual([THREAD_CHANGED]);
  });

  test("the broker cannot answer: the rows are closed all the same, and announced", async () => {
    const db = withRows();
    add(db, "cut", [testo("sto misurando"), tool()], 1);
    const frames: unknown[] = [];
    expect(await settleReattachLeg(ctxOf(db, frames), "topic:x", () => Promise.reject(new Error("socket gone")))).toBe(1);
    expect(rowOf(db, "cut").partial).toBe(0);
    expect(frames).toEqual([THREAD_CHANGED]);
  });

  test("the broker says the turn is still open: the row stays live, and no window is told anything", async () => {
    const db = withRows();
    // The leg's finalize left `partial` off on a turn that goes on.
    add(db, "asking", [testo("devo chiederti una cosa"), tool()], 0);
    const frames: unknown[] = [];
    expect(await settleReattachLeg(ctxOf(db, frames), "topic:x", async () => "open" as const)).toBe(0);
    const row = rowOf(db, "asking");
    expect(row.partial).toBe(1);
    expect(row.blocks.some((b) => b.kind === "error")).toBe(false);
    expect(frames).toEqual([]);
  });

  test("nothing left open: nothing written, nobody told", async () => {
    const db = withRows();
    add(db, "done", [testo("sto misurando"), tool()], 0);
    const frames: unknown[] = [];
    expect(await settleReattachLeg(ctxOf(db, frames), "topic:x", async () => "idle" as const)).toBe(0);
    expect(rowOf(db, "done").blocks.some((b) => b.kind === "error")).toBe(false);
    expect(frames).toEqual([]);
  });
});

/**
 * AND server.ts ENDS EVERY LEG THERE. The tests above drive the helper; its one
 * caller is the `.finally` of the boot reattach leg (`reattachSurvivingChatTurns`),
 * which runs only when a broker child survived a restart, and no test server
 * has one. So the wiring is pinned by reading the source, as
 * `swap-freeze.wiring.test.ts` does: without the call the rows stay open and
 * unexplained, and with a context other than the server's the windows are not
 * told. The two-window e2e the card asks for stays out for the same reason
 * (triage of card edf3c4db).
 */
describe("the boot reattach leg is settled by settleReattachLeg", () => {
  test("its `.finally` passes the server's context and the broker's word", () => {
    const server = readFileSync(join(import.meta.dir, "../../server.ts"), "utf8");
    const start = server.indexOf("async function reattachSurvivingChatTurns(");
    expect(start, "reattachSurvivingChatTurns is gone from server.ts").toBeGreaterThan(-1);
    const body = server.slice(start, server.indexOf("\n}\n", start));
    const leg = body.indexOf("runHeadlessReattach(s.id");
    expect(leg, "the reattach leg is gone").toBeGreaterThan(-1);
    const legEnd = body.indexOf("continue;", leg);
    const settle = body.indexOf(".finally(() => settleReattachLeg(ctx, s.id,", leg);
    expect(settle, "the leg's end does not call settleReattachLeg(ctx, s.id, ...)").toBeGreaterThan(-1);
    expect(settle, "settleReattachLeg is not on the leg's own chain").toBeLessThan(legEnd);
    expect(body.slice(settle, legEnd)).toContain("brokerTurnState?.(sk)");
  });
});
