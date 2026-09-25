/**
 * THE HUMAN CHANNEL OF A CHAT WITH NO CARD: WHO THE LOCK SPEAKS FOR, AND WHOSE
 * THE YES IS.
 *
 * Both rules live on the same surface and neither had coverage there, because
 * every test of the pair was written against a card: on the board the routing's
 * `busy` reports the first fact and `answerTo` carries the second, and off it
 * there is no thread, so both roads are different code.
 *
 * THE YES BELONGS TO THAT QUESTION, IN CHAT TOO.
 *
 * The routes run FOR REAL (`/api/chat/tool-response` from the topics router and
 * the `ask-user` leg from the permission router), and so do the rendez-vous
 * (`ask-user-bridge`, an in-memory map) and the send gate (`outbound-gate`):
 * mocking them would have removed the very thing under test, which is that an
 * answer reaches the right question and no other. Only the DB and the two
 * channels that write are fake (the thread comment and the panel), and here they
 * record instead of writing. Nothing is ever sent: the gate stops at the
 * confirmation.
 *
 * The regression it watches, measured with these two routes and no card: the
 * rendez-vous is keyed by SESSION, so a yes clicked on any panel was delivered
 * to whoever was waiting. With a send confirmation waiting and the generic
 * question parked by the gate - whose form is on screen anyway, painted by the
 * stream detector - the yes given to the generic one killed the confirmation
 * ("the answer that came back was not about this message") and left the generic
 * question unanswered. One click, two questions damaged.
 *
 * @covers OUTBOUND-03
 */
import { describe, test, expect } from "bun:test";
import { tmpdir } from "os";
import { createTopicsRouter } from "./topics";
import { createPermissionRouter } from "./permission";
import { cancelAsk, deliverAnswer, ASK_NOT_CURRENT_LINE } from "../lib/ask-user-bridge";
import { _resetRoutedAsks } from "../services/board-ask-routing";
import {
  confirmOutbound,
  confirmQuestion,
  CONFIRM_LABEL,
  REFUSE_LABEL,
  _resetOutboundHolds,
  type ConfirmOutcome,
  type OutboundGateDeps,
} from "../lib/outbound-gate";

type Row = { id: string; tool_calls?: string | null; blocks?: string | null };

const sendRow = (id: string): Row => ({
  id: `row-of-${id}`,
  tool_calls: JSON.stringify([{ id, name: "mcp__topics__send_mail", status: "running" }]),
  blocks: null,
});

/**
 * A minimal `ctx` shared by both routers: the DB hands back the chat row the
 * test decided on, and no card at all (`boardTaskForSession` finds nothing) -
 * which is exactly the shape where the rule was missing entirely.
 */
function makeHarness(row: Row) {
  const broadcasts: Array<{ type: string } & Record<string, unknown>> = [];
  const toolCallWrites: Array<{ toolCallId: string; fields: Record<string, unknown>; rowId?: string }> = [];
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const ctx = {
    // No handler on this path reads it; the router dereferences it on mount.
    OPENCLAW_DIR: tmpdir(),
    db: {
      // The session's recent rows, as the answer route reads them to find the
      // row that carries the panel it writes on.
      prepare: (sql: string) => ({ get: () => undefined, all: () => (String(sql).includes("FROM messages") ? [row] : []) }),
      query: () => ({ get: () => null, all: () => [] }),
    },
    json,
    errorResponse: (status: number, error: string) => json({ error }, status),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute: (pathname: string, pattern: string): Record<string, string> | null => {
      const pp = pattern.split("/");
      const xp = pathname.split("/");
      if (pp.length !== xp.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
        else if (pp[i] !== xp[i]) return null;
      }
      return params;
    },
    broadcastToAll: (msg: { type: string } & Record<string, unknown>) => { broadcasts.push(msg); },
    getTopicBySessionKey: (key: string) => ({ id: `topic-of-${key}`, sessionKey: key, autonomyLevel: "auto-apply" }),
    saveSingleTopic: () => {},
    updateToolCallFields: (_sessionKey: string, toolCallId: string, fields: Record<string, unknown>, opts?: { rowId?: string }) => {
      toolCallWrites.push({ toolCallId, fields, rowId: opts?.rowId });
    },
  } as any;

  const topicsRouter = createTopicsRouter(ctx);
  const permissionRouter = createPermissionRouter(ctx, {});
  const call = (router: typeof topicsRouter, method: string, path: string, body?: unknown) => {
    const url = new URL(`http://topics.test${path}`);
    const req = new Request(url.toString(), {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return router(req, url, url.pathname, method) as Promise<Response | null>;
  };

  /** The person's click on the `toolCallId` panel, as it is on the wire. */
  const answerPanel = (sessionKey: string, toolCallId: string, answers: Record<string, string>) =>
    call(topicsRouter, "POST", "/api/chat/tool-response", {
      sessionKey,
      toolCallId,
      response: { kind: "questions", answers },
    });

  /** One poll leg of the bridge's generic question. */
  const askLeg = (sessionKey: string, question: string, legMs: number) =>
    call(permissionRouter, "POST", `/api/sessions/${sessionKey}/ask-user`, {
      questions: [{ key: "piano", question, options: ["Si", "No"] }],
      legMs,
    });

  const gate = (paints: string[]): OutboundGateDeps => ({
    db: ctx.db as never,
    comment: () => null,
    deliver: (sessionKey, answers) => deliverAnswer(sessionKey, answers),
    lastToolRow: () => row,
    paint: (args) => { paints.push(args.toolCallId); },
  });

  return { answerPanel, askLeg, gate, broadcasts, toolCallWrites };
}

const sendRequest = (sessionKey: string, summary: string, digest: string, legMs = 3_000) => ({
  sessionKey,
  toolName: "mcp__topics__send_mail",
  header: "Posta",
  summary,
  digest,
  legMs,
});

/** A promise still in flight has no outcome: this makes that an assertion. */
function watch(p: Promise<ConfirmOutcome>) {
  let settled: ConfirmOutcome | null = null;
  p.then((o) => { settled = o; }, () => { settled = { state: "refused", reason: "errore" }; });
  return () => settled;
}

describe("POST /api/chat/tool-response: la risposta nomina la domanda", () => {
  test("il si' dato al pannello PARCHEGGIATO non paga l'invio, e non uccide la sua attesa", async () => {
    const sk = "chat:abcd7001";
    const row = sendRow("tool-7001");
    const h = makeHarness(row);
    const paints: string[] = [];
    try {
      // The send confirmation is on screen on its own row, and it is waiting.
      const send = confirmOutbound(h.gate(paints), sendRequest(sk, "Invio una mail dall'account primo.", "abcd1234"));
      const sendOutcome = watch(send);
      await Bun.sleep(20);
      expect(paints).toEqual(["tool-7001"]);

      // The generic question parks: that is the previous round's fix.
      const parked = (await h.askLeg(sk, "Procedo col piano B?", 120))!;
      expect(await parked.json()).toEqual({ pending: true });

      // BUT ITS PANEL IS ALREADY ON SCREEN: the stream detector paints it from
      // the `tool_use`, not the leg's route. The person clicks that one, and
      // that is the click that used to pay for the send.
      const wrong = (await h.answerPanel(sk, "tool-generica", { "Procedo col piano B?": "Si" }))!;
      expect(wrong.status).toBe(409);
      expect(await wrong.json()).toEqual({ error: ASK_NOT_CURRENT_LINE, code: "ask_not_current" });
      // Nothing delivered, nothing written, and above all no wait killed: the
      // confirmation is still the one the person is reading.
      expect(h.toolCallWrites).toHaveLength(0);
      expect(h.broadcasts).toHaveLength(0);
      await Bun.sleep(20);
      expect(sendOutcome()).toBeNull();

      // And the yes given to ITS panel pays for it.
      const right = (await h.answerPanel(sk, "tool-7001", {
        [confirmQuestion("Invio una mail dall'account primo.", "abcd1234")]: CONFIRM_LABEL,
      }))!;
      expect(right.status).toBe(200);
      expect((await send).state).toBe("granted");
      // On the send's own row, by id: the panel lives there.
      expect(h.toolCallWrites.map((w) => [w.toolCallId, w.rowId])).toEqual([["tool-7001", "row-of-tool-7001"]]);
    } finally {
      cancelAsk(sk);
      _resetOutboundHolds();
      _resetRoutedAsks();
    }
  });

  test("il pannello di un turno FINITO lo dice, invece di rubare il turno a quello vivo", async () => {
    const sk = "chat:abcd7002";
    // The previous turn left its panel on screen; the live one is on the new
    // row, and it is the only question waiting on anybody.
    const row = sendRow("tool-nuovo");
    const h = makeHarness(row);
    const paints: string[] = [];
    try {
      const first = confirmOutbound(h.gate(paints), sendRequest(sk, "Invio vecchio.", "0000aaaa", 3_000));
      await Bun.sleep(20);
      // That confirmation ends with a no: its row stays on screen, its wait
      // does not.
      deliverAnswer(sk, { [confirmQuestion("Invio vecchio.", "0000aaaa")]: REFUSE_LABEL });
      expect((await first).state).toBe("refused");

      const live = confirmOutbound(h.gate(paints), sendRequest(sk, "Invio nuovo.", "1111bbbb", 3_000));
      const liveOutcome = watch(live);
      await Bun.sleep(20);

      const stale = (await h.answerPanel(sk, "tool-vecchio", {
        [confirmQuestion("Invio vecchio.", "0000aaaa")]: CONFIRM_LABEL,
      }))!;
      expect(stale.status).toBe(409);
      expect((await stale.json()).code).toBe("ask_not_current");
      await Bun.sleep(20);
      expect(liveOutcome()).toBeNull();

      // The live confirmation is still answerable, and its yes is its own.
      const right = (await h.answerPanel(sk, "tool-nuovo", {
        [confirmQuestion("Invio nuovo.", "1111bbbb")]: CONFIRM_LABEL,
      }))!;
      expect(right.status).toBe(200);
      expect((await live).state).toBe("granted");
    } finally {
      cancelAsk(sk);
      _resetOutboundHolds();
      _resetRoutedAsks();
    }
  });

  test("una domanda generica da sola si risponde dal suo pannello come sempre", async () => {
    // THE FALLBACK BRANCH, declared: a wait opened without naming a row - the
    // generic leg, which does not paint the panel itself - still receives the
    // answer whatever panel sent it. It only gets there when no confirmation of
    // this session holds the lock, so its question is the only one that can be
    // waiting.
    const sk = "chat:abcd7003";
    const h = makeHarness(sendRow("tool-7003"));
    try {
      const inFlight = h.askLeg(sk, "Procedo col piano B?", 2_000);
      await Bun.sleep(20);
      const answered = (await h.answerPanel(sk, "tool-della-generica", { "Procedo col piano B?": "Si" }))!;
      expect(answered.status).toBe(200);
      expect(await (await inFlight)!.json()).toEqual({ answers: { "Procedo col piano B?": "Si" } });
    } finally {
      cancelAsk(sk);
      _resetOutboundHolds();
      _resetRoutedAsks();
    }
  });

  test("un invio ABBANDONATO non rende muta la domanda dopo, ne' parcheggiandola ne' legandola al suo pannello", async () => {
    // TWO RULES ABOUT THE SAME DEAD SEND, and the leg below is where both are
    // paid. The hold has to lapse on the WALL clock - the ask leg calls
    // `outboundHoldOfSession` with no clock of its own, so nothing but a route
    // can prove the real one reaches it, and without the expiry this session
    // would never ask another question until a restart. And the identity, which
    // says "this is the question on screen", has to change when that question
    // does: the abandoned send already named its row, and if that name stayed,
    // the generic question that follows it - the only live one, and with no row
    // of its own to name - would have a panel on screen and a 409 on every
    // click.
    const sk = "chat:abcd7004";
    const row = sendRow("tool-7004");
    const h = makeHarness(row);
    const paints: string[] = [];
    try {
      // Two minutes behind: the leg expires and the hold is already dead to
      // anybody reading the real clock.
      const abandoned = await confirmOutbound(
        { ...h.gate(paints), now: () => Date.now() - 120_000 },
        sendRequest(sk, "Invio di un agente che non torna.", "dead0001", 200),
      );
      expect(abandoned.state).toBe("pending");
      expect(paints).toEqual(["tool-7004"]);

      const inFlight = h.askLeg(sk, "E adesso?", 2_000);
      await Bun.sleep(20);
      const answered = (await h.answerPanel(sk, "tool-della-generica", { "E adesso?": "Si" }))!;
      expect(answered.status).toBe(200);
      expect(await (await inFlight)!.json()).toEqual({ answers: { "E adesso?": "Si" } });
    } finally {
      cancelAsk(sk);
      _resetOutboundHolds();
      _resetRoutedAsks();
    }
  });
});

describe("POST /api/sessions/:sessionKey/ask-user: per chi parla il lucchetto", () => {
  /**
   * THE LOCK IS ONE SESSION'S, AND OFF THE BOARD NOTHING SAID SO.
   *
   * The map of holds is global and the ask leg reads it by walking all of it.
   * Drop the session comparison in `outboundHoldOfSession` and the whole branch
   * suite stayed green, while ONE send would park the generic questions of
   * EVERY other session on the machine - and several sessions is the normal
   * shape here, a coordinator and its children. The sibling rule on a card is
   * measured through `routed.busy`, where the map of holds is empty: it proves
   * the other road entirely.
   *
   * @covers OUTBOUND-03
   */
  test("il lucchetto di UN'ALTRA sessione non parcheggia la mia domanda", async () => {
    const sender = "chat:abcd7005";
    const mine = "chat:abcd7006";
    const h = makeHarness(sendRow("tool-7005"));
    const paints: string[] = [];
    try {
      const send = confirmOutbound(h.gate(paints), sendRequest(sender, "Invio della sessione col lucchetto.", "aaaa1111"));
      await Bun.sleep(20);
      expect(paints).toEqual(["tool-7005"]);

      // My question is a rendez-vous of MINE: it registers and it is answered.
      const inFlight = h.askLeg(mine, "E la mia?", 2_000);
      await Bun.sleep(20);
      const answered = (await h.answerPanel(mine, "tool-mia", { "E la mia?": "Si" }))!;
      expect(answered.status).toBe(200);
      expect(await (await inFlight)!.json()).toEqual({ answers: { "E la mia?": "Si" } });

      // And the send of the other session is still waiting on its own panel.
      cancelAsk(sender);
      expect((await send).state).toBe("refused");
    } finally {
      cancelAsk(sender);
      cancelAsk(mine);
      _resetOutboundHolds();
      _resetRoutedAsks();
    }
  });

});
