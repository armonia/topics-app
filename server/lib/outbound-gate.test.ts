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
import { confirmOutbound, confirmKey, confirmQuestion, findWaitingToolRow, CONFIRM_LABEL, REFUSE_LABEL, type OutboundGateDeps } from "./outbound-gate";
import { deliverAnswer, hasPendingAsk, cancelAsk } from "./ask-user-bridge";
import { _resetRoutedAsks } from "../services/board-ask-routing";

afterEach(() => { _resetRoutedAsks(); });

const CARD = { id: "task-1", project_id: "project-1", assigned_topic_id: "topic-abcd1234" };

function makeDeps(options: { card?: boolean; row?: { tool_calls?: string | null; blocks?: string | null } | null } = {}) {
  const comments: Array<{ taskId: string; content: string; options: string[] }> = [];
  const paints: Array<{ toolCallId: string; schema: unknown }> = [];
  const deps: OutboundGateDeps = {
    db: {
      prepare: () => ({ get: () => (options.card ? CARD : undefined) }),
    } as never,
    comment: (args) => { comments.push({ taskId: args.taskId, content: args.content, options: args.options }); return true; },
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
    // dirty by the first answer.
    expect(comments).toHaveLength(2);
    expect(comments[1].content).toContain("22222222");
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
