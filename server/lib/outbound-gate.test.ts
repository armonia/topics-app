/**
 * THE HUMAN YES THAT STANDS IN FRONT OF EVERY SEND.
 *
 * The rendez-vous runs FOR REAL (`ask-user-bridge` is an in-memory map, no
 * network and no DB): mocking it would have removed the very thing under test,
 * which is that a yes reaches the RIGHT question and that everything else does
 * not pass. Only the DB and the two outbound channels are fake (the thread
 * comment and the chat panel), and here they record instead of writing.
 *
 * The regressions it watches:
 *   - a yes that covers the NEXT message (the shape of "always allow", right
 *     for a tool that edits a file, wrong for a mail);
 *   - an answer buffered from ANOTHER question read as consent: the bridge
 *     keeps one aside for 30 seconds;
 *   - a question nobody can see, holding a send open until it expires;
 *   - the thread registry left dirty after an answer that arrived through the
 *     panel: the next message's question would silently stop reaching the card.
  * @covers OUTBOUND-03
 */
import { afterEach, describe, expect, test } from "bun:test";
import { confirmOutbound, confirmKey, confirmQuestion, findWaitingToolRow, outboundHoldOfSession, CONFIRM_LABEL, REFUSE_LABEL, CONFIRM_ANSWERED_ELSEWHERE_LINE, _resetOutboundHolds, _outboundHoldCount, type OutboundGateDeps } from "./outbound-gate";
import { deliverAnswer, hasPendingAsk, cancelAsk } from "./ask-user-bridge";
import { _resetRoutedAsks, routeAskToTaskThread } from "../services/board-ask-routing";

afterEach(() => { _resetRoutedAsks(); _resetOutboundHolds(); });

const CARD = { id: "task-1", project_id: "project-1", assigned_topic_id: "topic-abcd1234" };

function makeDeps(options: { card?: boolean; row?: { tool_calls?: string | null; blocks?: string | null } | null } = {}) {
  const comments: Array<{ taskId: string; content: string; options: string[] }> = [];
  const paints: Array<{ toolCallId: string; schema: unknown }> = [];
  const deps: OutboundGateDeps = {
    db: {
      prepare: () => ({ get: () => (options.card ? CARD : undefined) }),
    } as never,
    comment: (args) => { comments.push({ taskId: args.taskId, content: args.content, options: args.options }); return `c-${comments.length}`; },
    deliver: (sessionKey, answers) => deliverAnswer(sessionKey, answers),
    lastToolRow: () => options.row ?? null,
    paint: (args) => { paints.push({ toolCallId: args.toolCallId, schema: args.schema }); },
  };
  return { deps, comments, paints };
}

const request = (sessionKey: string, digest = "abcd1234") => ({
  sessionKey,
  toolName: "mcp__topics__send_mail",
  header: "Posta",
  summary: "Invio una mail dall'account primo.",
  digest,
  legMs: 150,
});

const runningRow = (id: string, name = "mcp__topics__send_mail") =>
  ({ tool_calls: JSON.stringify([{ id, name, status: "running" }]), blocks: null });

describe("confirmOutbound", () => {
  test("nessuna risposta: la gamba scade in `pending` e NIENTE parte", async () => {
    const { deps, comments } = makeDeps({ card: true });
    const sessionKey = "topic:abcd1234";
    const outcome = await confirmOutbound(deps, request(sessionKey));
    expect(outcome.state).toBe("pending");
    // The question went out in the card thread, once.
    expect(comments).toHaveLength(1);
    expect(comments[0].options).toEqual([CONFIRM_LABEL, REFUSE_LABEL]);
    // And it stays OPEN between legs: it is the same panel.
    expect(hasPendingAsk(sessionKey)).toBe(true);
    cancelAsk(sessionKey, "fine del test");
  });

  test("la parola di consenso, con la chiave di QUESTO messaggio, apre", async () => {
    const { deps } = makeDeps({ card: true });
    const sessionKey = "topic:abcd1235";
    const pending = confirmOutbound(deps, request(sessionKey));
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey("abcd1234")]: CONFIRM_LABEL }); }, 10);
    expect((await pending).state).toBe("granted");
  });

  test("qualunque altra risposta NON e' un consenso", async () => {
    const { deps } = makeDeps({ card: true });
    const sessionKey = "topic:abcd1236";
    const pending = confirmOutbound(deps, request(sessionKey));
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey("abcd1234")]: REFUSE_LABEL }); }, 10);
    const outcome = await pending;
    expect(outcome.state).toBe("refused");
    expect(outcome.state === "refused" && outcome.reason).toContain(REFUSE_LABEL);
  });

  test("una risposta che riguarda un ALTRO messaggio non vale come si", async () => {
    const { deps } = makeDeps({ card: true });
    const sessionKey = "topic:abcd1237";
    const pending = confirmOutbound(deps, request(sessionKey, "abcd1234"));
    // Same word, another message's key: this is a previous question's buffered
    // answer, not consent to this one.
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey("99999999")]: CONFIRM_LABEL }); }, 10);
    const outcome = await pending;
    expect(outcome.state).toBe("refused");
    expect(outcome.state === "refused" && outcome.reason).toContain("not about this message");
  });

  test("in chat il pannello si dipinge sulla riga in attesa, e la risposta torna per TESTO", async () => {
    const { deps, paints, comments } = makeDeps({ card: false, row: runningRow("tool-77") });
    const sessionKey = "chat-session-1";
    const pending = confirmOutbound(deps, request(sessionKey));
    setTimeout(() => {
      // The chat panel keys its answers by question TEXT: that is how
      // `ToolInputForm` builds `answers`.
      deliverAnswer(sessionKey, { [confirmQuestion("Invio una mail dall'account primo.", "abcd1234")]: CONFIRM_LABEL });
    }, 10);
    expect((await pending).state).toBe("granted");
    expect(paints).toHaveLength(1);
    expect(paints[0].toolCallId).toBe("tool-77");
    // No card: no comment, and that is not an error.
    expect(comments).toHaveLength(0);
  });

  test("nessuna card e nessuna riga: si RIFIUTA subito invece di aspettare uno che non vede", async () => {
    const { deps } = makeDeps({ card: false, row: null });
    const sessionKey = "chat-session-2";
    const outcome = await confirmOutbound(deps, request(sessionKey));
    expect(outcome.state).toBe("refused");
    expect(outcome.state === "refused" && outcome.reason).toContain("nobody could confirm");
    // And no wait is left hanging on the session.
    expect(hasPendingAsk(sessionKey)).toBe(false);
  });

  test("una domanda VECCHIA nel registro non rende muta la conferma", async () => {
    // The shape the verifier reproduced: an `ask_user_question` whose turn was
    // interrupted leaves its entry in the routing registry, and none of the
    // three clears covers that case. `routeAskToTaskThread` then returned the
    // task WITHOUT writing anything, the gate read that as "asked", and the
    // send waited four hours for an answer to a question about fonts.
    const { deps, comments } = makeDeps({ card: true });
    const sessionKey = "topic:abcd1260";
    routeAskToTaskThread(
      { db: deps.db, comment: deps.comment, deliver: deps.deliver },
      { sessionKey, questions: [{ key: "font", question: "Che font uso?", options: ["Inter", "Roboto"] }] },
    );
    expect(comments).toHaveLength(1);

    const outcome = await confirmOutbound(deps, request(sessionKey, "deadbeef"));
    expect(outcome.state).toBe("pending");
    // The question about the SEND is the one on the card now.
    expect(comments.at(-1)?.content).toContain("deadbeef");
    expect(comments.at(-1)?.content).toContain("Invio una mail");
    expect(comments.at(-1)?.options).toEqual([CONFIRM_LABEL, REFUSE_LABEL]);
    // And the one it replaced was closed out loud, not swapped in silence.
    expect(comments[1].content).toContain("non aspetta");
    cancelAsk(sessionKey, "fine del test");
  });

  /**
   * THE HOLD EXPIRES, AND THAT IS A RULE ABOUT A CLOCK.
   *
   * The promise is "the declared leg plus a margin, or an agent that dies
   * between two legs would keep the surface forever", and until now the
   * coverage faked the lapse with `_resetOutboundHolds()`: it proved the reset,
   * not the clock. Measured: dropping the `expiresAt` comparison altogether left
   * the suite green. Here the test owns the time, and the third request gets
   * through only because time passed.
   *
   * @covers OUTBOUND-03
   */
  test("il lucchetto SCADE: chi non torna piu' non tiene la superficie per sempre", async () => {
    const { deps } = makeDeps({ card: false, row: runningRow("tool-88") });
    let clock = 1_000_000;
    deps.now = () => clock;
    const sessionKey = "chat-session-3";

    // The first request: its leg expires with the question on screen, and the
    // hold stays its own.
    expect((await confirmOutbound(deps, { ...request(sessionKey), legMs: 20 })).state).toBe("pending");

    // It never comes back. While the lease runs, a request without its token is
    // turned away.
    clock += 20 + 29_000;
    const tooEarly = await confirmOutbound(deps, { ...request(sessionKey), legMs: 20 });
    expect(tooEarly.state).toBe("refused");
    expect(tooEarly.state === "refused" && tooEarly.reason).toContain("already has a confirmation");

    // Past the declared leg plus the grace, the surface is free again.
    clock += 2_000;
    expect((await confirmOutbound(deps, { ...request(sessionKey), legMs: 20 })).state).toBe("pending");
    cancelAsk(sessionKey, "fine del test");
  });

  /**
   * THE TWO PREDICATES OF `outboundHoldOfSession`, AND NEITHER WAS MEASURED.
   *
   * That function is what tells a generic `ask_user_question` that a send
   * confirmation of its own session is on screen, so it must park instead of
   * superseding the rendez-vous. It reads by SESSION and it reads the CLOCK, and
   * removing either left the whole branch suite green:
   *
   *   - without the session comparison, ONE session's send parks the questions
   *     of EVERY other session on the machine - the map is global, and the
   *     coordinator plus its children are several sessions by construction;
   *   - without the expiry, an agent that dies between two legs leaves a lapsed
   *     entry that nothing collects, and that session never asks another
   *     question until the server restarts.
   *
   * The clock is the test's, not the wall's: faking the lapse by clearing the
   * map would prove the reset, exactly the gap this closes.
   *
   * @covers OUTBOUND-03
   */
  test("il lucchetto parla per la SUA sessione e solo finche' e' vivo, poi esce dalla mappa", async () => {
    const { deps } = makeDeps({ card: false, row: runningRow("tool-99") });
    let clock = 2_000_000;
    deps.now = () => clock;
    const sessionKey = "chat-session-4";
    const stranger = "chat-session-5";
    const legMs = 20;

    // A send of `sessionKey` is on screen: its leg expired with the question up,
    // so the hold is its own and alive.
    expect((await confirmOutbound(deps, { ...request(sessionKey), legMs })).state).toBe("pending");
    expect(_outboundHoldCount()).toBe(1);

    // MINE, yes. Somebody else's, no: a hold is never an answer about another
    // session's questions.
    expect(outboundHoldOfSession(sessionKey, clock)).toBe(true);
    expect(outboundHoldOfSession(stranger, clock)).toBe(false);

    // Still mine for the last millisecond of the lease (leg + 30s of grace)...
    expect(outboundHoldOfSession(sessionKey, clock + legMs + 30_000 - 1)).toBe(true);
    // ...and not one millisecond past it: the agent never came back.
    expect(outboundHoldOfSession(sessionKey, clock + legMs + 30_000)).toBe(false);
    // And the dead entry is GONE, not merely ignored: nothing else collects it,
    // and a map that only grows is memory that never comes back.
    expect(_outboundHoldCount()).toBe(0);

    cancelAsk(sessionKey, "fine del test");
  });

  test("il si NON si eredita: il messaggio dopo chiede di nuovo, e la domanda riesce sul thread", async () => {
    const { deps, comments } = makeDeps({ card: true });
    const sessionKey = "topic:abcd1238";
    const first = confirmOutbound(deps, request(sessionKey, "11111111"));
    setTimeout(() => { deliverAnswer(sessionKey, { [confirmKey("11111111")]: CONFIRM_LABEL }); }, 10);
    expect((await first).state).toBe("granted");

    const second = confirmOutbound(deps, request(sessionKey, "22222222"));
    // No answer this time: the earlier consent covers nothing.
    expect((await second).state).toBe("pending");
    // And the second question DID reach the thread: the registry was not left
    // dirty by the first answer. In between, the first block was CLOSED: the
    // yes arrived through the panel in the tab, so nothing in the thread said
    // that question was over and its quick replies kept answering nobody.
    expect(comments).toHaveLength(3);
    expect(comments[1].content).toBe(CONFIRM_ANSWERED_ELSEWHERE_LINE);
    expect(comments[1].options).toEqual([]);
    expect(comments[2].content).toContain("22222222");
    cancelAsk(sessionKey, "fine del test");
  });
});

describe("findWaitingToolRow", () => {
  test("prende l'ULTIMA chiamata di quel nome ancora in corso", () => {
    const row = {
      tool_calls: JSON.stringify([
        { id: "a", name: "mcp__topics__send_mail", status: "success" },
        { id: "b", name: "Bash", status: "running" },
        { id: "c", name: "mcp__topics__send_mail", status: "running" },
      ]),
      blocks: null,
    };
    expect(findWaitingToolRow(row, "mcp__topics__send_mail")).toEqual({ toolCallId: "c", alreadyWaiting: false });
  });

  test("i blocchi battono `tool_calls`, che su quelle righe e' vuoto", () => {
    const row = {
      tool_calls: "[]",
      blocks: JSON.stringify([{ kind: "tool", toolCall: { id: "z", name: "mcp__topics__send_mail", status: "running" } }]),
    };
    expect(findWaitingToolRow(row, "mcp__topics__send_mail")?.toolCallId).toBe("z");
  });

  test("una riga gia' in attesa non si ridipinge", () => {
    const row = { tool_calls: JSON.stringify([{ id: "w", name: "mcp__topics__send_mail", status: "waiting_for_input" }]), blocks: null };
    expect(findWaitingToolRow(row, "mcp__topics__send_mail")).toEqual({ toolCallId: "w", alreadyWaiting: true });
  });

  test("una chiamata gia' finita non aspetta nessuno", () => {
    const row = { tool_calls: JSON.stringify([{ id: "a", name: "mcp__topics__send_mail", status: "success" }]), blocks: null };
    expect(findWaitingToolRow(row, "mcp__topics__send_mail")).toBeNull();
  });

  test("il NOME NUDO e' la stessa chiamata: il runtime nativo non mette prefissi", () => {
    // `topicsToolSpecs` (providers/native/topics-tools.ts) maps `toolsForProfile`
    // straight through, so the native runtime executes and PERSISTS `send_mail`
    // with no fleet prefix - and the native provider is what 702 of the 776
    // topics on this machine run. Matching only the prefixed form meant: no
    // row found, `asked = false`, and every send in a chat refused with
    // "nobody could confirm". Exactly the bug ask-user-detector.ts:44-60
    // already wrote down for `ask_user_question` on 2026-08-28.
    const bare = { tool_calls: JSON.stringify([{ id: "n", name: "send_mail", status: "running" }]), blocks: null };
    expect(findWaitingToolRow(bare, "mcp__topics__send_mail")).toEqual({ toolCallId: "n", alreadyWaiting: false });
    const blocks = {
      tool_calls: "[]",
      blocks: JSON.stringify([{ kind: "tool", toolCall: { id: "g", name: "google_call", status: "running" } }]),
    };
    expect(findWaitingToolRow(blocks, "mcp__topics__google_call")?.toolCallId).toBe("g");
  });

  test("un altro server MCP che espone lo stesso mestiere e' la stessa riga, un omonimo NO", () => {
    // `mcp__other__send_mail` is the same tool behind another mount point, and
    // it is what a fleet rename produces. `my_send_mail` is somebody else's
    // tool that merely ends the same way: a suffix match with no separator
    // would have swallowed it.
    const mounted = { tool_calls: JSON.stringify([{ id: "m", name: "mcp__other__send_mail", status: "running" }]), blocks: null };
    expect(findWaitingToolRow(mounted, "mcp__topics__send_mail")?.toolCallId).toBe("m");
    const namesake = { tool_calls: JSON.stringify([{ id: "x", name: "my_send_mail", status: "running" }]), blocks: null };
    expect(findWaitingToolRow(namesake, "mcp__topics__send_mail")).toBeNull();
  });

  test("JSON illeggibile non esplode: nessuna riga", () => {
    expect(findWaitingToolRow({ tool_calls: "{non json", blocks: null }, "mcp__topics__send_mail")).toBeNull();
  });
});
