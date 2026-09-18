/**
 * Copertura di rotta per il CANALE UMANO (server/routes/permission.ts): le
 * gambe di `ask-user` e `permission`, il click di `permission-response` e le
 * regole di `/api/tool-grants`.
 *
 * I due bridge (ask-user-bridge, permission-bridge) girano VERI: sono mappe in
 * memoria, senza DB né rete, e mockarli avrebbe tolto proprio ciò che qui si
 * vuole provare — che le tre uscite del rendez-vous (deciso / in attesa /
 * annullato) siano quelle giuste e che una decisione arrivi alla richiesta
 * GIUSTA. Finto c'è solo il contesto: `ctx` minimo, con un `db.prepare().get()`
 * che restituisce la riga di chat che il test ha deciso.
 *
 * Le regressioni che sorveglia:
 *   - `mcp__topics__*` che chiede il permesso di mostrare un pannello (7 agosto):
 *     la regola incorporata deve tagliare corto PRIMA di aprire un rendez-vous;
 *   - il click che torna con l'id della RIGA mentre la richiesta è indicizzata
 *     con quello della CLI: senza l'alias scritto dalla gamba, la decisione
 *     cadeva nel vuoto (409) e il turno restava fermo;
 *   - una `decision` non riconosciuta che diventa un sì per inerzia.
  * @covers PERM-06
 */
import { describe, test, expect } from "bun:test";
import { createPermissionRouter } from "./permission";
import { beginAsk, deliverAnswer, hasPendingAsk, cancelAsk, waitForAnswer } from "../lib/ask-user-bridge";
import { cancelPermission, hasPendingPermission, sessionHasPendingPermission } from "../lib/permission-bridge";
import { _resetRoutedAsks, pendingRoutedAsk, routeAskToTaskThread } from "../services/board-ask-routing";
import { confirmOutbound, confirmQuestion, CONFIRM_LABEL, _resetOutboundHolds, type OutboundGateDeps } from "../lib/outbound-gate";

type Row = { tool_calls?: string | null; blocks?: string | null } | undefined;

function makeHarness(row: Row = undefined, options: { rawGlobalSessions?: Iterable<string>; card?: { id: string; project_id: string; assigned_topic_id: string } } = {}) {
  const threadComments: Array<{ taskId: string; content: string }> = [];
  const broadcasts: Array<{ type: string } & Record<string, unknown>> = [];
  const toolCallWrites: Array<{ sessionKey: string; toolCallId: string; fields: Record<string, unknown> }> = [];
  const rawGlobalSessions = new Set(options.rawGlobalSessions ?? []);

  /**
   * I topic della finta app. Uno per session key, coniato alla prima richiesta
   * con il livello che ha una chat normale (`auto-apply` → `acceptEdits`, cioè
   * la modalità che CHIEDE). Sono veri oggetti mutabili perché è esattamente
   * ciò che «passa a libero» va a scrivere, ed è l'unico modo di provare che
   * scrive sulla chat GIUSTA e su nessun'altra.
   */
  const topics = new Map<string, { id: string; sessionKey: string; autonomyLevel: string }>();
  const topicFor = (key: string) => {
    let t = topics.get(key);
    if (!t) {
      t = { id: `topic-of-${key}`, sessionKey: key, autonomyLevel: "auto-apply" };
      topics.set(key, t);
    }
    return t;
  };

  const ctx = {
    db: {
      // `boardTaskForSession` and the tool-row lookup share this one stub: a
      // test that declares a card gets the card row, the others get the chat
      // row they asked for.
      prepare: () => ({ get: () => (options.card ?? row) }),
      // This deliberately models only the raw registry lookup. A coordinator
      // with corrupt provider/project fields is still a registry role and must
      // be rejected before any generic bridge side effect.
      query: () => ({
        get: (_scope: string, sessionKey: string) => rawGlobalSessions.has(sessionKey)
          ? { scope: "global", topic_id: "registered-coordinator", created_at: "now", updated_at: "now" }
          : null,
      }),
    },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
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
    getTopicBySessionKey: (key: string) => topicFor(key),
    saveSingleTopic: (t: { id: string; sessionKey: string; autonomyLevel: string }) => {
      topics.set(t.sessionKey, { id: t.id, sessionKey: t.sessionKey, autonomyLevel: t.autonomyLevel });
    },
    updateToolCallFields: (sessionKey: string, toolCallId: string, fields: Record<string, unknown>) => {
      toolCallWrites.push({ sessionKey, toolCallId, fields });
    },
  } as any;

  const router = createPermissionRouter(ctx, options.card ? { comment: (a) => { threadComments.push({ taskId: a.taskId, content: a.content }); return `c-${threadComments.length}`; } } : {});
  const call = (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://topics.test${path}`);
    const req = new Request(url.toString(), {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return router(req, url, url.pathname, method) as Promise<Response | null>;
  };
  return { call, broadcasts, toolCallWrites, topicFor, threadComments, db: ctx.db as never };
}

const callRow = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify([{ id, name: "Bash", status: "running", ...extra }]);

describe("POST /api/sessions/:sessionKey/ask-user", () => {
  test("senza domande è 400 e NON apre nessuna attesa", async () => {
    const h = makeHarness();
    const sk = "ask:empty";
    const resp = (await h.call("POST", `/api/sessions/${sk}/ask-user`, { questions: [] }))!;
    expect(resp.status).toBe(400);
    // Un 400 che avesse comunque aperto l'ask lascerebbe la sessione «ferma su
    // una persona» per tutto il TTL, senza pannello a schermo.
    expect(hasPendingAsk(sk)).toBe(false);
  });

  test("la gamba scade: {pending:true} e la domanda resta APERTA", async () => {
    const h = makeHarness();
    const sk = "ask:leg";
    try {
      const resp = (await h.call("POST", `/api/sessions/${sk}/ask-user`, { questions: [{ q: "?" }], legMs: 100 }))!;
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ pending: true });
      // La scadenza è della GAMBA, non dell'ask: se chiudesse la domanda, il
      // pannello sparirebbe dopo il primo poll.
      expect(hasPendingAsk(sk)).toBe(true);
    } finally { cancelAsk(sk); }
  });

  test("la risposta arriva: torna {answers} e la domanda si chiude", async () => {
    const h = makeHarness();
    const sk = "ask:answered";
    // Ordine reale: la gamba è già in attesa quando la persona preme invia.
    const inFlight = h.call("POST", `/api/sessions/${sk}/ask-user`, { questions: [{ q: "?" }], legMs: 5_000 });
    await Bun.sleep(20);
    expect(deliverAnswer(sk, { colore: "blu" })).toBe(true);
    const resp = (await inFlight)!;
    expect(await resp.json()).toEqual({ answers: { colore: "blu" } });
    expect(hasPendingAsk(sk)).toBe(false);
  });
});

describe("la domanda che esce nel THREAD della card", () => {
  const CARD = { id: "task-1", project_id: "project-1", assigned_topic_id: "topic-abcd1234" };

  test("dopo una risposta arrivata dal PANNELLO, la domanda DOPO esce ancora sulla card", async () => {
    // The `routeAskToTaskThread` registry is keyed by TASK and exists so the
    // same comment is not rewritten on every leg. Nobody cleared it when the
    // answer came from the tab: the two existing clears are the TTL expiry and
    // an answer written in the thread. So the NEXT question found the entry
    // still there and stopped reaching the card - "waiting on you" with no text
    // of what it wants, which is the defect that module exists to close.
    _resetRoutedAsks();
    const h = makeHarness(undefined, { card: CARD });
    const sk = "topic:abcd1234";
    try {
      const first = h.call("POST", `/api/sessions/${sk}/ask-user`, {
        questions: [{ key: "k1", question: "Prima domanda?", options: ["Sì", "No"] }],
        legMs: 5_000,
      });
      await Bun.sleep(20);
      expect(h.threadComments).toHaveLength(1);
      // The person answers from the tab PANEL, not from the thread.
      expect(deliverAnswer(sk, { k1: "Sì" })).toBe(true);
      expect(await (await first)!.json()).toEqual({ answers: { k1: "Sì" } });

      const second = h.call("POST", `/api/sessions/${sk}/ask-user`, {
        questions: [{ key: "k2", question: "Seconda domanda?", options: ["Sì", "No"] }],
        legMs: 5_000,
      });
      await Bun.sleep(20);
      expect(h.threadComments).toHaveLength(2);
      expect(h.threadComments[1].content).toContain("Seconda domanda?");
      deliverAnswer(sk, { k2: "No" });
      await second;
    } finally {
      cancelAsk(sk);
      _resetRoutedAsks();
    }
  });

  /**
   * A GENERIC QUESTION DOES NOT KILL THE SEND CONFIRMATION UNDER IT.
   *
   * The rendez-vous is keyed by SESSION and `waitForAnswer` supersedes whatever
   * waiter it finds there, on purpose - the CLI blocks its turn on one built-in
   * ask. But the MCP bridge does not await its handlers, so an
   * `ask_user_question` and a `send_mail` of the SAME turn are both in flight on
   * one session, and this leg used to register anyway: measured with both real
   * routes, the send came back "superseded by a newer question", took its own
   * registry entry with it, and left its confirmation on the card with buttons
   * that reached nobody. The card is taken and this ask waits its turn, which
   * means spending the leg WITHOUT registering: nothing of the question on the
   * card is touched.
   *
   * @covers OUTBOUND-03
   */
  test("una domanda generica NON supera l'attesa di una conferma della stessa sessione", async () => {
    _resetRoutedAsks();
    const h = makeHarness(undefined, { card: CARD });
    const sk = "topic:abcd1234";
    const routing = {
      // The same stub the route reads the card through: the registry has to
      // land on the same task the leg below resolves to.
      db: h.db,
      comment: (a: { taskId: string; projectId: string; content: string; options: string[]; sessionKey?: string }) => {
        h.threadComments.push({ taskId: a.taskId, content: a.content });
        return `c-${h.threadComments.length}`;
      },
      deliver: () => true,
    };
    try {
      // The send: its question is on the card and its leg is on the rendez-vous.
      beginAsk(sk);
      const confirmation = routeAskToTaskThread(routing, {
        sessionKey: sk,
        questions: [{ key: "outbound:aaa", question: "Preventivo -> cliente@esempio.test. Confermi?", options: ["Conferma", "Annulla"] }],
      })!;
      const sendLeg = waitForAnswer(sk, { timeoutMs: 3_000 });
      let sendDied: string | null = null;
      sendLeg.catch((err) => { sendDied = err instanceof Error ? err.message : String(err); });

      const startedAt = Date.now();
      const genericLeg = (await h.call("POST", `/api/sessions/${sk}/ask-user`, {
        questions: [{ key: "piano", question: "Procedo col piano B?", options: ["Si", "No"] }],
        legMs: 120,
      }))!;
      expect(await genericLeg.json()).toEqual({ pending: true });
      // AND IT SPENT THE LEG. Answering `pending` without waiting is not
      // cosmetic: the MCP client comes STRAIGHT back on `pending` with no delay
      // of its own, so the question would burn its 600 legs in an instant and
      // die with "gave up after 600 poll legs" instead of waiting its turn.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110);
      // Nothing written: the card keeps ONE block to read...
      expect(h.threadComments).toHaveLength(1);
      // ...the registry still names the confirmation...
      expect(pendingRoutedAsk(CARD.id)?.askId).toBe(confirmation.askId!);
      // ...and the send is still waiting, which is the fact that was false.
      expect(sendDied).toBeNull();

      // And the yes reaches it.
      expect(deliverAnswer(sk, { "outbound:aaa": "Conferma" })).toBe(true);
      expect(await sendLeg).toEqual({ "outbound:aaa": "Conferma" });
    } finally {
      cancelAsk(sk);
      _resetRoutedAsks();
    }
  });

  /**
   * ANOTHER SESSION'S QUESTION IS ANOTHER RENDEZ-VOUS, and this leg registers.
   *
   * The branch above spends its leg WITHOUT registering, and getting it wrong
   * the other way costs a question nobody ever sees: two sessions of one task
   * exist by construction (the coordinator and its children), and one of them
   * can hold the card for hours. The "SAME session" condition is what keeps the
   * two apart, and nothing measured it - removing it left the suite green.
   *
   * @covers OUTBOUND-03
   */
  test("la domanda di un'ALTRA sessione sulla stessa card non ferma questa", async () => {
    _resetRoutedAsks();
    const h = makeHarness(undefined, { card: CARD });
    const otherSession = "topic:abcd1234";
    const mine = "topic:abcd7777";
    const routing = {
      db: h.db,
      comment: (a: { taskId: string; projectId: string; content: string; options: string[]; sessionKey?: string }) => {
        h.threadComments.push({ taskId: a.taskId, content: a.content });
        return `c-${h.threadComments.length}`;
      },
      deliver: () => true,
    };
    try {
      // The other session holds the card and is waiting on it.
      beginAsk(otherSession);
      const held = routeAskToTaskThread(routing, {
        sessionKey: otherSession,
        questions: [{ key: "k-altra", question: "Domanda dell'altra sessione?", options: ["Si", "No"] }],
      })!;
      const otherLeg = waitForAnswer(otherSession, { timeoutMs: 3_000 });
      let otherDied: string | null = null;
      otherLeg.catch((err) => { otherDied = err instanceof Error ? err.message : String(err); });

      // Mine registers anyway: the rendez-vous is keyed by SESSION, and this one
      // is mine.
      const inFlight = h.call("POST", `/api/sessions/${mine}/ask-user`, {
        questions: [{ key: "mia", question: "E la mia?", options: ["Si", "No"] }],
        legMs: 2_000,
      });
      await Bun.sleep(20);
      expect(deliverAnswer(mine, { mia: "Si" })).toBe(true);
      expect(await (await inFlight)!.json()).toEqual({ answers: { mia: "Si" } });

      // And the other session's question is untouched: not rewritten, not
      // replaced, not cancelled.
      expect(pendingRoutedAsk(CARD.id)?.askId).toBe(held.askId!);
      expect(otherDied).toBeNull();
    } finally {
      cancelAsk(otherSession);
      cancelAsk(mine);
      _resetRoutedAsks();
    }
  });

  /**
   * OFF THE BOARD THE RULE IS THE SAME, AND THERE THE RACE WAS STILL INTACT.
   *
   * The branch above hangs on `routed.busy`, which only exists when the session
   * belongs to a task: in a chat `routeAskToTaskThread` returns null, so this leg
   * registered and the send confirmation of the same session died "superseded by
   * a newer question". Reproduced with both real routes and no card: the yes the
   * person gave on the SEND panel was delivered to the generic question. Here the
   * fact comes from the gate's own lock, whose key for a session with no card is
   * exactly `session:<k>`.
   *
   * @covers OUTBOUND-03
   */
  test("senza card: una domanda generica NON supera la conferma d'invio della stessa sessione", async () => {
    const sk = "chat:abcd1301";
    const row = {
      tool_calls: JSON.stringify([{ id: "tool-91", name: "mcp__topics__send_mail", status: "running" }]),
      blocks: null,
    };
    const h = makeHarness(row);
    const paints: Array<{ toolCallId: string }> = [];
    const gate: OutboundGateDeps = {
      db: h.db,
      // No card: there is no thread, and the comment has nowhere to go.
      comment: () => null,
      deliver: (sessionKey, answers) => deliverAnswer(sessionKey, answers),
      lastToolRow: () => row,
      paint: (args) => { paints.push({ toolCallId: args.toolCallId }); },
    };
    try {
      // The send: its panel is on the tool row and its leg is on the rendez-vous.
      const send = confirmOutbound(gate, {
        sessionKey: sk,
        toolName: "mcp__topics__send_mail",
        header: "Posta",
        summary: "Invio una mail dall'account primo.",
        digest: "abcd1234",
        legMs: 3_000,
      });
      await Bun.sleep(20);
      expect(paints).toHaveLength(1);

      const startedAt = Date.now();
      const generic = (await h.call("POST", `/api/sessions/${sk}/ask-user`, {
        questions: [{ key: "piano", question: "Procedo col piano B?", options: ["Si", "No"] }],
        legMs: 120,
      }))!;
      expect(await generic.json()).toEqual({ pending: true });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110);
      // No second panel: the person keeps reading the confirmation.
      expect(paints).toHaveLength(1);

      // And the yes read on the SEND panel pays the send, not the generic one.
      expect(deliverAnswer(sk, {
        [confirmQuestion("Invio una mail dall'account primo.", "abcd1234")]: CONFIRM_LABEL,
      })).toBe(true);
      expect((await send).state).toBe("granted");
    } finally {
      cancelAsk(sk);
      _resetOutboundHolds();
    }
  });
});

describe("POST /api/sessions/:sessionKey/permission", () => {
  test("senza toolName o toolUseId è 400", async () => {
    const h = makeHarness();
    const a = (await h.call("POST", "/api/sessions/p:1/permission", { toolUseId: "tu_1" }))!;
    expect(a.status).toBe(400);
    const b = (await h.call("POST", "/api/sessions/p:1/permission", { toolName: "Bash" }))!;
    expect(b.status).toBe(400);
    expect(hasPendingPermission("p:1", "tu_1")).toBe(false);
  });

  test("le mani di Topics non chiedono: allow immediato, nessun pannello, nessuna attesa", async () => {
    const h = makeHarness();
    const sk = "p:bridge";
    const resp = (await h.call("POST", `/api/sessions/${sk}/permission`, {
      toolName: "mcp__topics__ask_user_question", toolUseId: "tu_b", legMs: 100,
    }))!;
    expect(await resp.json()).toEqual({ decision: "allow" });
    // Il 7 agosto: per mostrare un pannello serviva il permesso di mostrare un
    // pannello. Se il corto-circuito cade, qui compare un frame e una richiesta
    // aperta — e questo caso deve rompersi.
    expect(h.broadcasts).toHaveLength(0);
    expect(hasPendingPermission(sk, "tu_b")).toBe(false);
  });

  test("riga in attesa già dipinta: NON si ridipinge (nessuna scrittura, nessun frame)", async () => {
    const h = makeHarness({
      tool_calls: callRow("tu_p", { status: "awaiting_permission", permissionRequest: { toolName: "Bash", input: {}, requestedAt: 1 } }),
    });
    const sk = "p:painted";
    try {
      const resp = (await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_p", legMs: 100 }))!;
      expect(await resp.json()).toEqual({ pending: true });
      expect(h.toolCallWrites).toHaveLength(0);
      expect(h.broadcasts).toHaveLength(0);
    } finally { cancelPermission(sk, "tu_p"); }
  });

  test("riga NON dipinta: scrive awaiting_permission e manda il frame del pannello", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_np") });
    const sk = "p:unpainted";
    try {
      await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_np", input: { command: "ls" }, legMs: 100 });
      expect(h.toolCallWrites).toHaveLength(1);
      expect(h.toolCallWrites[0]).toMatchObject({ sessionKey: sk, toolCallId: "tu_np" });
      expect(h.toolCallWrites[0].fields.status).toBe("awaiting_permission");
      const frame = h.broadcasts.find((b) => b.type === "stream:tool_permission_required")!;
      expect(frame).toMatchObject({ sessionKey: sk, toolCallId: "tu_np", topicId: `topic-of-${sk}` });
      expect((frame.request as { input: unknown }).input).toEqual({ command: "ls" });
    } finally { cancelPermission(sk, "tu_np"); }
  });
});

describe("POST /api/sessions/:sessionKey/permission-response", () => {
  test("senza toolCallId è 400", async () => {
    const h = makeHarness();
    const resp = (await h.call("POST", "/api/sessions/r:1/permission-response", { decision: "allow" }))!;
    expect(resp.status).toBe(400);
  });

  test("una decision che non riconosciamo è un 400, non un sì per inerzia", async () => {
    const h = makeHarness();
    const resp = (await h.call("POST", "/api/sessions/r:2/permission-response", { toolCallId: "x", decision: "yes" }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).code).toBe("invalid_decision");
  });

  test("nessuna richiesta aperta sotto il pannello: 409, non un ok muto", async () => {
    const h = makeHarness();
    const resp = (await h.call("POST", "/api/sessions/r:3/permission-response", { toolCallId: "x", decision: "allow" }))!;
    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe("permission_not_pending");
  });

  test("giro completo con RIPIEGO PER NOME: il click torna con l'id della riga e trova la richiesta", async () => {
    // La CLI passa `cli_id`, che Topics non ha persistito; la riga a schermo è
    // `riga`. La gamba dipinge su `riga` e SCRIVE l'alias — senza quello, il
    // click qui sotto sarebbe un 409 e il turno resterebbe fermo per sempre.
    const h = makeHarness({ tool_calls: callRow("riga") });
    const sk = "r:alias";
    const leg = (await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "cli_id", legMs: 100 }))!;
    expect(await leg.json()).toEqual({ pending: true });
    expect(h.broadcasts[0]).toMatchObject({ type: "stream:tool_permission_required", toolCallId: "riga" });

    const resp = (await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "riga", decision: "allow" }))!;
    expect(resp.status).toBe(200);
    expect(hasPendingPermission(sk, "cli_id")).toBe(false);
    // L'esito RESTA sulla riga: chi rilegge la chat vede chi ha detto cosa.
    const write = h.toolCallWrites.at(-1)!;
    expect(write.toolCallId).toBe("riga");
    expect(write.fields.status).toBe("running");
    expect((write.fields.permissionOutcome as { decision: string }).decision).toBe("allow");
    const resolved = h.broadcasts.find((b) => b.type === "stream:tool_permission_resolved")!;
    expect(resolved).toMatchObject({ sessionKey: sk, toolCallId: "riga" });
  });

  test("click FRA due gambe: la gamba dopo torna la parola dell'umano, senza riaprire né ridipingere", async () => {
    // The bridge polls, so there is a gap between legs with no waiter. A click
    // in that gap closes the request and buffers the decision. The next leg
    // must hand that decision back at the TOP - before rules, before
    // `beginPermission` - or it re-opens a decided request and repaints a
    // panel nobody needs to press again.
    const h = makeHarness({ tool_calls: callRow("tu_gap") });
    const sk = "r:gap";
    const leg1 = (await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_gap", legMs: 100 }))!;
    expect(await leg1.json()).toEqual({ pending: true });
    const paints = () => h.broadcasts.filter((b) => b.type === "stream:tool_permission_required").length;
    expect(paints()).toBe(1);

    const resp = (await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "tu_gap", decision: "allow" }))!;
    expect(resp.status).toBe(200);
    expect(hasPendingPermission(sk, "tu_gap")).toBe(false);

    const leg2 = (await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_gap", legMs: 100 }))!;
    expect(await leg2.json()).toEqual({ decision: "allow" });
    // Decided is decided: no second panel, no request left open for the TTL.
    expect(paints()).toBe(1);
    expect(hasPendingPermission(sk, "tu_gap")).toBe(false);
  });

  test("un DENY si consegna com'è e resta scritto sulla riga", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_d") });
    const sk = "r:deny";
    await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_d", legMs: 100 });
    const resp = (await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "tu_d", decision: "deny" }))!;
    expect(resp.status).toBe(200);
    const outcome = h.toolCallWrites.at(-1)!.fields.permissionOutcome as { decision: string };
    expect(outcome.decision).toBe("deny");
  });
});

describe("global coordinator human-bridge isolation", () => {
  test("raw registry coordinator cannot enter ask, permission, or permission-response paths", async () => {
    const sk = "topic:registered-coordinator";
    const h = makeHarness(undefined, { rawGlobalSessions: [sk] });

    const ask = (await h.call("POST", `/api/sessions/${sk}/ask-user`, { questions: [{ question: "?" }] }))!;
    expect(ask.status).toBe(403);
    expect((await ask.json()).code).toBe("orchestrator_topic_invariant");
    expect(hasPendingAsk(sk)).toBe(false);

    const permission = (await h.call("POST", `/api/sessions/${sk}/permission`, {
      toolName: "Bash", toolUseId: "coordinator-tool", legMs: 100,
    }))!;
    expect(permission.status).toBe(403);
    expect(hasPendingPermission(sk, "coordinator-tool")).toBe(false);

    const response = (await h.call("POST", `/api/sessions/${sk}/permission-response`, {
      toolCallId: "coordinator-tool", decision: "allow_free",
    }))!;
    expect(response.status).toBe(403);
    expect(h.toolCallWrites).toEqual([]);
    expect(h.broadcasts).toEqual([]);
    // In particular, a direct `allow_free` could not mutate its Topic's
    // autonomy level and widen a later generic session.
    expect(h.topicFor(sk).autonomyLevel).toBe("auto-apply");
  });
});

/**
 * «PASSA A LIBERO» — la terza azione del pannello.
 *
 * Una sola pressione fa tre cose, e le tre si provano SEPARATE: se una sola
 * mancasse, un test che le guarda insieme resterebbe verde per il motivo
 * sbagliato. Il caso peggiore è proprio il verde a metà — la richiesta
 * consentita e la sessione NON liberata (il pannello successivo ricompare), o
 * la sessione liberata e nessuna traccia di chi l'ha deciso.
 */
describe("«Passa a libero»: consente ORA e libera la sessione", () => {
  test("(a) la richiesta in corso si risolve come CONSENTITA — e la CLI non vede mai la quarta parola", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_free_a") });
    const sk = "free:a";
    // Ordine reale: il bridge è già dentro la sua gamba quando la persona preme.
    const leg = h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_free_a", legMs: 5_000 });
    await Bun.sleep(20);

    const resp = (await h.call("POST", `/api/sessions/${sk}/permission-response`, {
      toolCallId: "tu_free_a",
      decision: "allow_free",
    }))!;
    expect(resp.status).toBe(200);

    // La gamba si sblocca con un `allow`: `allow_free` è una decisione di
    // Topics su sé stesso, e consegnarla al figlio CLI sarebbe una parola
    // sconosciuta al posto di un permesso.
    expect(await (await leg)!.json()).toEqual({ decision: "allow" });
    expect(hasPendingPermission(sk, "tu_free_a")).toBe(false);
  });

  test("(b) la sessione passa in modalità libera, e il selettore di autonomia lo viene a sapere", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_free_b") });
    const sk = "free:b";
    expect(h.topicFor(sk).autonomyLevel).toBe("auto-apply");

    await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_free_b", legMs: 100 });
    const resp = (await h.call("POST", `/api/sessions/${sk}/permission-response`, {
      toolCallId: "tu_free_b",
      decision: "allow_free",
    }))!;

    expect((await resp.json()).autonomyLevel).toBe("yolo");
    expect(h.topicFor(sk).autonomyLevel).toBe("yolo");
    // Il `topic:updated` è ciò che fa dire «Libero» al selettore nel composer —
    // cioè l'unico comando da cui si torna indietro. Senza, il regime sarebbe
    // cambiato di nascosto.
    const updated = h.broadcasts.find((b) => b.type === "topic:updated");
    expect(updated).toBeTruthy();
    expect((updated!.topic as { autonomyLevel: string }).autonomyLevel).toBe("yolo");
  });

  test("(c) resta una riga nel thread: cosa è stato fatto, e da chi", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_free_c") });
    const sk = "free:c";
    await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_free_c", legMs: 100 });
    await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "tu_free_c", decision: "allow_free" });

    // La traccia si scrive sulla RIGA della chat (`permissionOutcome`), che è
    // ciò che sopravvive al reload ed è quello che il thread disegna. Un
    // `allow` liscio non basterebbe: dopo, rileggendo, «consentito» e
    // «consentito e da qui non chiedo più» sembrerebbero la stessa cosa.
    const write = h.toolCallWrites.at(-1)!;
    const outcome = write.fields.permissionOutcome as { decision: string; actor?: string; decidedAt: string };
    expect(write.toolCallId).toBe("tu_free_c");
    expect(outcome.decision).toBe("allow_free");
    expect(outcome.actor).toBeTruthy();
    expect(outcome.decidedAt).toBeTruthy();
    // E arriva anche a chi sta guardando adesso, non solo a chi ricarica.
    const resolved = h.broadcasts.find((b) => b.type === "stream:tool_permission_resolved")!;
    expect((resolved.outcome as { decision: string }).decision).toBe("allow_free");
    expect((resolved.outcome as { actor?: string }).actor).toBeTruthy();
  });

  test("il turno prosegue: il pannello SUCCESSIVO non compare", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_free_next") });
    const sk = "free:next";
    await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_free_next", legMs: 100 });
    await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "tu_free_next", decision: "allow_free" });
    const before = h.broadcasts.length;

    // Lo strumento DOPO, nello stesso turno, con lo stesso figlio CLI ancora
    // nato in `acceptEdits`: se questa gamba aprisse un pannello, «passa a
    // libero» avrebbe liberato la sessione solo dal turno successivo — cioè
    // non avrebbe fatto quello che dice.
    const next = (await h.call("POST", `/api/sessions/${sk}/permission`, {
      toolName: "mcp__gateway__kiwi__search-flight",
      toolUseId: "tu_free_next_2",
      legMs: 100,
    }))!;
    expect(await next.json()).toEqual({ decision: "allow" });
    expect(hasPendingPermission(sk, "tu_free_next_2")).toBe(false);
    expect(h.broadcasts.length).toBe(before);
  });

  test("vale per QUESTA sessione: le altre continuano a chiedere", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_mia") });
    const mia = "free:mia";
    const altra = "free:altra";
    await h.call("POST", `/api/sessions/${mia}/permission`, { toolName: "Bash", toolUseId: "tu_mia", legMs: 100 });
    await h.call("POST", `/api/sessions/${mia}/permission-response`, { toolCallId: "tu_mia", decision: "allow_free" });

    // Il livello dell'altra chat non si è mosso…
    expect(h.topicFor(altra).autonomyLevel).toBe("auto-apply");
    // …e soprattutto il suo canale CHIEDE ancora: nessuna regola globale è
    // stata scritta. È la differenza con «Consenti sempre», che invece vale per
    // tutta l'app — e sarebbe stata la scorciatoia sbagliata da prendere qui.
    try {
      const resp = (await h.call("POST", `/api/sessions/${altra}/permission`, {
        toolName: "Bash",
        toolUseId: "tu_altra",
        legMs: 100,
      }))!;
      expect(await resp.json()).toEqual({ pending: true });
      expect(hasPendingPermission(altra, "tu_altra")).toBe(true);
    } finally {
      cancelPermission(altra, "tu_altra");
    }
  });

  test("è REVERSIBILE da dove si è cambiata: rimesso «agisce», si torna a chiedere", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_rev") });
    const sk = "free:rev";
    await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_rev", legMs: 100 });
    await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "tu_rev", decision: "allow_free" });
    expect(h.topicFor(sk).autonomyLevel).toBe("yolo");

    // Quello che fa il selettore di autonomia nel composer (PATCH del topic).
    h.topicFor(sk).autonomyLevel = "auto-apply";

    try {
      const resp = (await h.call("POST", `/api/sessions/${sk}/permission`, {
        toolName: "Bash",
        toolUseId: "tu_rev_2",
        legMs: 100,
      }))!;
      // Un permesso che si toglie e non si può rimettere non è un permesso.
      expect(await resp.json()).toEqual({ pending: true });
    } finally {
      cancelPermission(sk, "tu_rev_2");
    }
  });

  test("due pannelli aperti insieme: nessuno resta appeso a chiedere a vuoto", async () => {
    // La CLI può chiedere per più `tool_use` nello stesso messaggio (misurati a
    // 170 ms di distanza). Liberata la sessione, il secondo pannello non ha più
    // niente da chiedere: se restasse aperto, il turno resterebbe «in attesa di
    // una persona» — cioè fuori dalla vista di watchdog e reaper — mentre la
    // persona ha già risposto per tutti.
    const h = makeHarness({ tool_calls: callRow("tu_due_1") });
    const sk = "free:due";
    const primo = h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_due_1", legMs: 5_000 });
    const secondo = h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Write", toolUseId: "tu_due_2", legMs: 5_000 });
    await Bun.sleep(20);
    expect(hasPendingPermission(sk, "tu_due_2")).toBe(true);

    await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "tu_due_1", decision: "allow_free" });

    expect(await (await primo)!.json()).toEqual({ decision: "allow" });
    expect(await (await secondo)!.json()).toEqual({ decision: "allow" });
    expect(hasPendingPermission(sk, "tu_due_2")).toBe(false);
    expect(sessionHasPendingPermission(sk)).toBe(false);
    // E la riga del secondo non resta a girare su «in attesa della tua risposta».
    // L'ULTIMA scrittura, non la prima: la prima è il pannello che si dipinge.
    const write = h.toolCallWrites.filter((w) => w.toolCallId === "tu_due_2").at(-1)!;
    expect(write.fields.status).toBe("running");
    expect((write.fields.permissionOutcome as { decision: string }).decision).toBe("allow");
  });
});

describe("/api/tool-grants", () => {
  test("GET elenca le regole", async () => {
    const h = makeHarness();
    const resp = (await h.call("GET", "/api/tool-grants"))!;
    expect(resp.status).toBe(200);
    expect(Array.isArray((await resp.json()).grants)).toBe(true);
  });

  test("POST senza pattern è 400", async () => {
    const h = makeHarness();
    const resp = (await h.call("POST", "/api/tool-grants", { pattern: "   " }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toContain("required");
  });

  test("un asterisco NUDO non è una regola: 400 con codice, non un consenso a tutto", async () => {
    const h = makeHarness();
    const resp = (await h.call("POST", "/api/tool-grants", { pattern: "*" }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).code).toBe("invalid_pattern");
  });

  test("un percorso che non è del canale non viene rivendicato", async () => {
    const h = makeHarness();
    expect(await h.call("GET", "/api/topics")).toBeNull();
    expect(await h.call("POST", "/api/sessions/x/switch-topic", { topicId: "y" })).toBeNull();
  });
});
