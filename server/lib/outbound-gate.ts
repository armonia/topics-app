/**
 * THE HUMAN YES THAT HAS TO EXIST BEFORE ANYTHING LEAVES THIS MACHINE.
 *
 * WHERE IT LIVES, AND WHY NOT IN THE TOOL DESCRIPTION. A sentence in a tool
 * schema ("ask the user first") is advice to a model: it holds until the model
 * decides it already asked, or until a prompt convinces it otherwise. This gate
 * runs on the SERVER, inside the route that spawns the CLI, so the confirmation
 * is not a step the agent performs — it is the thing standing between the
 * request and the process. Calling the route by hand does not skip it.
 *
 * WHICH CHANNEL. The one the board already has, not a new one:
 *   - a session that belongs to a task puts the question in the card's thread
 *     as a comment with quick replies (`routeAskToTaskThread`), which is where
 *     a person already answers a mid-turn question;
 *   - a chat session gets the standard panel painted on the row of the tool
 *     that is waiting, the same shape plan approval uses.
 * Both answers come back through ONE rendez-vous (`ask-user-bridge`), so there
 * is a single waiter and no way for two channels to disagree.
 *
 * WHY NOT THE PERMISSION BRIDGE. That one is designed to be able to STOP
 * asking: `allow_always` writes a durable grant, and a session switched to
 * "free" is answered `allow` without a panel. Both are right for a tool that
 * edits a file in a worktree and both are wrong here — a yes given for one
 * message must not cover the next one. This gate has no grants, no free mode
 * and no memory: every message opens its own question.
 *
 * ONE REQUEST AT A TIME ON ONE CARD, AND THAT IS ENFORCED HERE, not inferred
 * from how the routing treats two identical questions. A card draws a single
 * quick-reply block and the rendez-vous is keyed by SESSION, so two requests
 * that reach the question at the same time cancel each other: measured, two
 * `send_mail` of one message 120 ms apart ended with one refused, the other
 * waiting on an entry the refused one had deleted, and a confirmation on screen
 * whose buttons reached nothing. The MCP bridge makes that the normal case - it
 * handles every JSON-RPC line in a callback it does not await - so the gate
 * takes a HOLD on the card before it writes anything or opens anything, and
 * whoever does not get it is turned away having touched NOTHING. The hold spans
 * the legs of one request: the route hands its token back with `pending` and the
 * next leg carries it, which is what tells one request's second leg apart from a
 * second request with a byte-identical payload. Nothing else can.
 *
 * THE ANSWER IS BOUND TO THE MESSAGE. The question carries a DIGEST of the
 * payload, in its key and in its text, and only an answer that comes back under
 * one of those two identities counts. Without it, an answer buffered from an
 * unrelated question (`deliverAnswer` keeps one for 30s) could be read as
 * consent to something the person never saw.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { beginAsk, cancelAsk, waitForAnswer, AskWaitError } from "./ask-user-bridge";
import { routeAskToTaskThread, closeRoutedAsk, type AskRoutingDeps } from "../services/board-ask-routing";
import { boardTaskForSession } from "../services/agent-census";
import type { UserInputSchema } from "../types";

/** The word that sends. Anything else, including silence, does not. */
export const CONFIRM_LABEL = "Conferma";
/** The word that stops it. Present so refusing is one click, not a free text. */
export const REFUSE_LABEL = "Annulla";

export type ConfirmOutcome =
  | { state: "granted" }
  /**
   * This leg expired with the question still on screen: come straight back,
   * carrying `hold`. The token is the request's identity across legs and the
   * only thing that keeps its own next leg from being turned away as a second
   * request: with a byte-identical payload nothing else tells the two apart.
   */
  | { state: "pending"; hold: string }
  | { state: "refused"; reason: string };

/** What the gate answers a request that arrives on a card somebody else holds. */
export const CARD_HELD_REASON =
  "this card already has a confirmation waiting for an answer: nothing is sent until that one is closed";

/** Closes the confirmation block when the request died without an answer. */
export const CONFIRM_ENDED_LINE =
  "Questa conferma non aspetta piu' una risposta: non e' stata consegnata e non e' partito niente.";

/** Closes it when the yes (or the no) arrived through the panel in the tab. */
export const CONFIRM_ANSWERED_ELSEWHERE_LINE =
  "A questa conferma e' stato risposto dal pannello della chat: il blocco qui sopra non aspetta piu' una risposta.";

/** The last persisted row of a session, with the two columns that draw tools. */
export interface ToolRowColumns {
  tool_calls?: string | null;
  blocks?: string | null;
}

export interface WaitingToolRow {
  toolCallId: string;
  /** True when the panel is already on that row: do not paint it twice. */
  alreadyWaiting: boolean;
}

interface ShownCall {
  id?: unknown;
  name?: unknown;
  status?: unknown;
}

function callsFromColumn(raw: string | null | undefined): ShownCall[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // `blocks` wraps the call; `tool_calls` is the call. Read both shapes here
    // so the caller does not have to know which column it handed over.
    return parsed
      .map((item) => {
        const block = item as { kind?: unknown; toolCall?: unknown };
        if (block?.kind === "tool" && block.toolCall) return block.toolCall as ShownCall;
        return item as ShownCall;
      })
      .filter((c): c is ShownCall => !!c && typeof c === "object");
  } catch {
    return [];
  }
}

/**
 * THE SAME TOOL UNDER THREE NAMES, and all three are this one.
 *
 * The caller knows the tool as the MCP fleet writes it, `mcp__topics__x`. That
 * is the name a CLI-driven agent records - and it is NOT the name the native
 * runtime records. `providers/native/topics-tools.ts` maps `toolsForProfile`
 * straight into the model's tool list, so there the tool is plain `x`, and the
 * bare name is what lands in `blocks`. On this machine the native provider owns
 * 702 of the 776 topics, i.e. the comparison that looked exact matched almost
 * nothing: no row, no panel, and every send in a chat refused with "nobody
 * could confirm".
 *
 * This is the SECOND time: `providers/ask-user-detector.ts:44-60` carries the
 * same three-way match and the same story, observed on 2026-08-28 on a chat
 * parked forever on a question with no control on screen.
 *
 * The third form is another mount point (`mcp__other__x`), which is the same
 * job behind a different server. The separator is part of the comparison on
 * purpose: a bare `endsWith("send_mail")` would also answer for somebody
 * else's `my_send_mail`.
 */
function sameTool(name: unknown, toolName: string): boolean {
  if (typeof name !== "string" || !name) return false;
  if (name === toolName) return true;
  const bare = toolName.includes("__") ? toolName.slice(toolName.lastIndexOf("__") + 2) : toolName;
  return name === bare || name.endsWith(`__${bare}`);
}

/**
 * The row to paint the question on: the LAST call of `toolName` that is still
 * running. Last and not first, because the same tool can appear several times
 * in one turn and the one waiting is the most recent.
 *
 * `blocks` wins over `tool_calls` when both are present, for the reason
 * `permission-paint.ts` writes down: a row with blocks carries `tool_calls =
 * '[]'` on disk, and reading only that column is how a panel stopped being
 * painted at all.
 */
export function findWaitingToolRow(
  row: ToolRowColumns | null | undefined,
  toolName: string,
): WaitingToolRow | null {
  if (!row) return null;
  const fromBlocks = callsFromColumn(row.blocks);
  const calls = fromBlocks.length ? fromBlocks : callsFromColumn(row.tool_calls);
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (typeof call.id !== "string" || !call.id) continue;
    if (!sameTool(call.name, toolName)) continue;
    const status = typeof call.status === "string" ? call.status : "";
    if (status === "waiting_for_input") return { toolCallId: call.id, alreadyWaiting: true };
    if (status === "running" || status === "pending" || status === "") {
      return { toolCallId: call.id, alreadyWaiting: false };
    }
  }
  return null;
}

export interface OutboundGateDeps {
  db: Database;
  /** Writes the quick-reply comment in a card thread. */
  comment: AskRoutingDeps["comment"];
  /** Hands an answer back to the waiting rendez-vous. */
  deliver: AskRoutingDeps["deliver"];
  /** The last persisted row of this session, or null when there is none. */
  lastToolRow: (sessionKey: string) => ToolRowColumns | null;
  /** Puts the panel on screen: persist the schema and announce it. */
  paint: (args: { sessionKey: string; toolCallId: string; schema: UserInputSchema }) => void;
  /**
   * The clock the LEASE is measured on, injectable for one reason: the rule
   * "a hold expires" is a rule about time, and a test that fakes the lapse by
   * clearing the map proves the reset instead of the clock - measured, a gate
   * with no expiry check at all passed the whole suite.
   */
  now?: () => number;
}

export interface ConfirmRequest {
  sessionKey: string;
  /** The tool name as the transcript records it, used to find the row. */
  toolName: string;
  /** Very short label above the question. */
  header: string;
  /** What is about to happen, in the words the person needs to decide. */
  summary: string;
  /** Identity of THIS payload. An answer to another one does not count. */
  digest: string;
  legMs: number;
  /**
   * The token the previous leg of THIS request was given, absent on the first.
   * A leg that carries it renews the hold; a leg that does not asks for a new
   * one and is refused while somebody else has it.
   */
  hold?: string;
}

/**
 * THE CARD, HELD BY ONE REQUEST AT A TIME.
 *
 * Keyed on the surface that draws the question, which is the card when the
 * session belongs to one and the session itself otherwise - a chat has no
 * thread, but it has the same single tool row and the same session-keyed
 * rendez-vous, so two requests collide there in exactly the same way.
 *
 * WHY A LEASE AND NOT A PLAIN LOCK. Between two legs of one request the hold
 * has to survive, and the request is a series of separate HTTP calls: an agent
 * whose process dies mid-confirmation would otherwise keep the card forever, and
 * every later send on it would be refused by a request nobody is running. The
 * lease is the leg the caller declared plus a grace, so a request that is still
 * polling renews it every leg by construction and one that has stopped lets it
 * go.
 */
interface CardHold {
  token: string;
  sessionKey: string;
  /** The thread row this request wrote, kept across its legs. Its id to clear. */
  askId?: string;
  expiresAt: number;
}

/** How long past its declared leg a hold survives a request that stops coming. */
const HOLD_GRACE_MS = 30_000;

const holds = new Map<string, CardHold>();

/** The surface that draws one question: the card, or the chat session itself. */
function holdKeyFor(deps: OutboundGateDeps, sessionKey: string): string {
  try {
    const card = boardTaskForSession(deps.db, sessionKey);
    if (card) return `card:${card.taskId}`;
  } catch {
    // A db that cannot answer is not a reason to let two requests through: the
    // session is a narrower surface than the card, never a wider one.
  }
  return `session:${sessionKey}`;
}

function acquireHold(
  key: string,
  args: { token?: string; sessionKey: string; leaseMs: number },
  now = Date.now(),
): CardHold | null {
  const current = holds.get(key);
  if (current && current.expiresAt > now) {
    if (!args.token || args.token !== current.token) return null;
    current.expiresAt = now + args.leaseMs;
    return current;
  }
  const hold: CardHold = { token: randomUUID(), sessionKey: args.sessionKey, expiresAt: now + args.leaseMs };
  holds.set(key, hold);
  return hold;
}

/** Only the holder releases, so a refused request cannot free the winner. */
function releaseHold(key: string, token: string): void {
  if (holds.get(key)?.token === token) holds.delete(key);
}

/** Tests only: the holds are process memory, like the registry next door. */
export function _resetOutboundHolds(): void {
  holds.clear();
}

/**
 * IS A SEND CONFIRMATION OF THIS SESSION WAITING RIGHT NOW?
 *
 * Asked by the generic `ask_user_question` leg (`routes/permission.ts`), which
 * must not take the rendez-vous away from a confirmation of its own session:
 * the rendez-vous is keyed by SESSION and `waitForAnswer` supersedes whatever
 * it finds. The routing's `busy` answers the same question ONLY on a card;
 * a chat session has no thread, so there the answer has to come from here -
 * measured with both real routes, a chat `ask_user_question` still killed the
 * confirmation under it and collected the yes the person gave to the send.
 *
 * Read by SESSION and not by hold key on purpose: the key is the surface that
 * draws the question (the card, or the session), and what the ask leg needs to
 * know is whose rendez-vous would be cut, which is the holder's session.
 */
export function outboundHoldOfSession(sessionKey: string, now = Date.now()): boolean {
  for (const hold of holds.values()) {
    if (hold.sessionKey === sessionKey && hold.expiresAt > now) return true;
  }
  return false;
}

/** The key the board channel answers under. Carries the digest on purpose. */
export function confirmKey(digest: string): string {
  return `outbound:${digest}`;
}

/**
 * The question text. The digest is IN it because the chat panel keys its
 * answers by question text, while the board keys them by `key`: one string
 * identifies the message on both roads.
 */
export function confirmQuestion(summary: string, digest: string): string {
  return `${summary}\n\nConfermi? (${digest})`;
}

function schemaFor(request: ConfirmRequest): UserInputSchema {
  return {
    kind: "questions",
    questions: [
      {
        question: confirmQuestion(request.summary, request.digest),
        header: request.header,
        options: [
          { label: CONFIRM_LABEL, description: "L'azione parte adesso, una volta sola." },
          { label: REFUSE_LABEL, description: "Non parte niente." },
        ],
      },
    ],
  };
}

/**
 * One LEG of the confirmation. Returns `pending` when nobody has answered yet,
 * exactly like the ask bridge: the caller comes straight back with the `hold`
 * token it was given, and the question stays on screen between legs.
 */
export async function confirmOutbound(
  deps: OutboundGateDeps,
  request: ConfirmRequest,
): Promise<ConfirmOutcome> {
  // THE HOLD IS TAKEN FIRST, BEFORE ANY WRITE AND BEFORE ANY RENDEZ-VOUS.
  //
  // Everything below - the comment in the thread, `beginAsk`, the panel, the
  // wait - is a step that another request arriving at the same time can undo.
  // Ordering them differently was the previous fix and it only closed the
  // instance that went through the routing's `busy` branch: two requests with
  // the SAME payload are the same question to that branch, so the second one
  // walked straight past it, joined the first one's rendez-vous and superseded
  // it. The hold does not care what the payload says. A request that does not
  // get it is refused HERE, having touched nothing at all.
  const holdKey = holdKeyFor(deps, request.sessionKey);
  const hold = acquireHold(
    holdKey,
    {
      token: request.hold,
      sessionKey: request.sessionKey,
      leaseMs: request.legMs + HOLD_GRACE_MS,
    },
    deps.now?.() ?? Date.now(),
  );
  if (!hold) return { state: "refused", reason: CARD_HELD_REASON };

  try {
    const outcome = await confirmHeld(deps, request, hold);
    if (outcome.state === "pending") return { state: "pending", hold: hold.token };
    releaseHold(holdKey, hold.token);
    return outcome;
  } catch (err) {
    releaseHold(holdKey, hold.token);
    throw err;
  }
}

/**
 * The same three outcomes before the hold token is stamped on `pending`: the
 * leg does not need to know its own token, and `confirmOutbound` is the only
 * place that knows whether the card stays held.
 */
type HeldOutcome =
  | { state: "granted" }
  | { state: "pending" }
  | { state: "refused"; reason: string };

/** The leg itself, with the card already held by THIS request. */
async function confirmHeld(
  deps: OutboundGateDeps,
  request: ConfirmRequest,
  hold: CardHold,
): Promise<HeldOutcome> {
  const key = confirmKey(request.digest);
  const question = confirmQuestion(request.summary, request.digest);

  // THE CARD IS ASKED FIRST, BEFORE THIS REQUEST OPENS A RENDEZ-VOUS OF ITS OWN.
  //
  // The hold above means no other send is in here at the same time, but a
  // generic `ask_user_question` of this same session can still be holding the
  // card - it takes no hold, it only needs the thread - and then this send must
  // be turned away before `beginAsk`, because that rendez-vous is keyed by
  // SESSION and waiting on it would cut the question already on screen.
  //
  // `shown` AND NOT "it returned a task". The two are not the same thing, and
  // the difference is a send left hanging in silence: that function also
  // returns the task when it decided NOT to write, and reading that as "the
  // person was asked" meant the confirmation existed nowhere: the card showed
  // another question, the send polled for four hours, nobody could have
  // answered it.
  let asked = false;
  /** The thread row THIS request wrote, on this leg or an earlier one. */
  let mine: string | undefined = hold.askId;
  let busy: { sessionKey: string; askedAt: number } | undefined;
  try {
    const routed = routeAskToTaskThread(
      { db: deps.db, comment: deps.comment, deliver: deps.deliver },
      { sessionKey: request.sessionKey, questions: [{ key, header: request.header, question, options: [CONFIRM_LABEL, REFUSE_LABEL] }] },
    );
    busy = routed?.busy;
    if (routed?.shown) {
      if (routed.created && routed.askId) {
        mine = routed.askId;
        hold.askId = routed.askId;
        asked = true;
      } else if (routed.askId && routed.askId === mine) {
        // My own earlier leg. Repeating the question is the heartbeat, not a
        // new one, and the row it points at is still the one I wrote.
        asked = true;
      } else {
        // AN ID THIS REQUEST DID NOT CREATE IS NOT THIS REQUEST'S TO OWN. The
        // routing hands the open entry's id to anybody repeating the same
        // question, and the previous shape adopted it - so two requests owned
        // one entry and the first to finish deleted it under the other. The
        // only safe answer is to treat the card as taken: nothing of that
        // question is touched, and this send is refused with a reason it can
        // report. Reachable when this request's hold lapsed while the row it
        // had written outlived it.
        busy = busy ?? { sessionKey: request.sessionKey, askedAt: Date.now() };
      }
    }
  } catch {
    // The panel below is the other road; a thread that refuses a comment must
    // not be the reason nobody can answer.
  }

  // THE CARD IS TAKEN BY A QUESTION THAT IS NOT THIS REQUEST'S, and this send
  // does not queue behind it.
  //
  // Refused rather than parked, and the reason is what a yes IS. A card draws
  // one quick-reply block: a second confirmation can only be shown by taking
  // the first one's place, and then the person reads one message and the yes
  // pays for another (reproduced: the quote a person read on screen confirmed,
  // and a mail to a different recipient sent). Waiting in silence is no better
  // for something irreversible - the agent would poll for four hours with
  // nothing on screen, and the human would never learn a send was queued. A
  // refusal with its own line is the only answer that is true when it is given:
  // the person keeps ONE confirmation to read, and the agent is told why, so it
  // can come back after the first one is closed.
  //
  // NOTHING IS CANCELLED HERE. There used to be a `cancelAsk` on this line,
  // from when the holder could only be another session; on the same session it
  // killed the rendez-vous the FIRST send was waiting on. This request has not
  // opened one yet - that is what the order above buys - so there is nothing of
  // ours to close and nothing of anybody else's to touch.
  if (busy && !asked) return { state: "refused", reason: CARD_HELD_REASON };

  if (!beginAsk(request.sessionKey)) {
    cancelAsk(request.sessionKey, "no answer: the confirmation expired");
    endMyQuestion(deps, hold, CONFIRM_ENDED_LINE);
    return { state: "refused", reason: "the confirmation expired with no answer" };
  }

  const schema = schemaFor(request);

  // The chat panel, on the row of the tool that is waiting.
  const target = findWaitingToolRow(deps.lastToolRow(request.sessionKey), request.toolName);
  if (target) {
    asked = true;
    if (!target.alreadyWaiting) {
      deps.paint({ sessionKey: request.sessionKey, toolCallId: target.toolCallId, schema });
    }
  }

  if (!asked) {
    // Neither road exists: no card thread and no row to paint on. Waiting here
    // would be a question nobody can see, held open until its TTL — so it is
    // refused NOW, with the reason, which is the only honest answer.
    cancelAsk(request.sessionKey, "nowhere to ask");
    return {
      state: "refused",
      reason: "there is no card thread and no visible tool row to ask on: nobody could confirm",
    };
  }

  try {
    const answers = await waitForAnswer(request.sessionKey, { timeoutMs: request.legMs });
    // THIS QUESTION IS OVER, whatever the answer says, and the card has to say
    // so. Leaving the entry behind means the NEXT message's question is
    // silently not posted, because the registry still believes one is open;
    // leaving the COMMENT behind unmarked means its buttons stay on screen over
    // a rendez-vous that is gone, and the click on them reaches nothing. An
    // answer that came through the thread already closed its own block with the
    // person's comment, and `endMyQuestion` writes nothing then.
    endMyQuestion(deps, hold, CONFIRM_ANSWERED_ELSEWHERE_LINE);
    // Both identities of the same question: the board answers under the key,
    // the chat panel under the question text.
    const raw = answers[key] ?? answers[question];
    if (typeof raw !== "string") {
      return { state: "refused", reason: "the answer that came back was not about this message" };
    }
    const said = raw.trim().toLowerCase();
    if (said !== CONFIRM_LABEL.toLowerCase()) {
      return { state: "refused", reason: `the person answered "${raw.trim()}"` };
    }
    return { state: "granted" };
  } catch (err) {
    if (err instanceof AskWaitError && err.code === "timeout") return { state: "pending" };
    endMyQuestion(deps, hold, CONFIRM_ENDED_LINE);
    return { state: "refused", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Close the question this request wrote, in the registry AND in the thread.
 *
 * The second half is the one that was missing. A cleared entry with the comment
 * still carrying its quick replies is a block of buttons that answers nobody:
 * the trace the route writes next to it is `quiet` on purpose, so it does not
 * take them away, and `pendingQuestionComment` keeps handing that row to the
 * drawer. Measured: the click delivered nothing, said nothing, and became an
 * ordinary comment.
 */
function endMyQuestion(deps: OutboundGateDeps, hold: CardHold, line: string): void {
  if (!hold.askId) return;
  closeRoutedAsk({ db: deps.db, comment: deps.comment, deliver: deps.deliver }, hold.askId, line);
  hold.askId = undefined;
}
