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
 * THE ANSWER IS BOUND TO THE MESSAGE. The question carries a DIGEST of the
 * payload, in its key and in its text, and only an answer that comes back under
 * one of those two identities counts. Without it, an answer buffered from an
 * unrelated question (`deliverAnswer` keeps one for 30s) could be read as
 * consent to something the person never saw.
 */
import type { Database } from "bun:sqlite";
import { beginAsk, cancelAsk, waitForAnswer, AskWaitError } from "./ask-user-bridge";
import { routeAskToTaskThread, clearRoutedAskForSession, type AskRoutingDeps } from "../services/board-ask-routing";
import type { UserInputSchema } from "../types";

/** The word that sends. Anything else, including silence, does not. */
export const CONFIRM_LABEL = "Conferma";
/** The word that stops it. Present so refusing is one click, not a free text. */
export const REFUSE_LABEL = "Annulla";

export type ConfirmOutcome =
  | { state: "granted" }
  /** This leg expired with the question still on screen: come straight back. */
  | { state: "pending" }
  | { state: "refused"; reason: string };

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
 * exactly like the ask bridge: the caller comes straight back, and the question
 * stays on screen between legs.
 */
export async function confirmOutbound(
  deps: OutboundGateDeps,
  request: ConfirmRequest,
): Promise<ConfirmOutcome> {
  const key = confirmKey(request.digest);
  const question = confirmQuestion(request.summary, request.digest);

  if (!beginAsk(request.sessionKey)) {
    cancelAsk(request.sessionKey, "no answer: the confirmation expired");
    return { state: "refused", reason: "the confirmation expired with no answer" };
  }

  const schema = schemaFor(request);
  // The card thread. Writes once per question: the registry inside
  // `routeAskToTaskThread` recognises the one it already posted.
  //
  // `shown` AND NOT "it returned a task". The two are not the same thing, and
  // the difference is a send left hanging in silence: that function also
  // returns the task when it decided NOT to write - and it was deciding that
  // whenever the registry still held any entry for this session, including one
  // left by a question of an interrupted turn. Reading the task as "the person
  // was asked" meant the confirmation existed nowhere: the card showed the old
  // question, the send polled for four hours, nobody could have answered it.
  let asked = false;
  let busy: { sessionKey: string; askedAt: number } | undefined;
  try {
    const routed = routeAskToTaskThread(
      { db: deps.db, comment: deps.comment, deliver: deps.deliver },
      { sessionKey: request.sessionKey, questions: [{ key, header: request.header, question, options: [CONFIRM_LABEL, REFUSE_LABEL] }] },
    );
    asked = routed?.shown === true;
    busy = routed?.busy;
  } catch {
    // The panel below is the other road; a thread that refuses a comment must
    // not be the reason nobody can answer.
  }

  // ANOTHER LIVE QUESTION HOLDS THE CARD, and this send does not queue behind
  // it. Two sessions of one task are the normal shape here - the coordinator
  // and its children map to the SAME taskId on purpose - so "the card already
  // has a confirmation open" is a state that happens, not a corner.
  //
  // Refused rather than parked, and the reason is what a yes IS. A card draws
  // one quick-reply block: a second confirmation can only be shown by taking
  // the first one's place, and then the person reads one message and the yes
  // pays for another (reproduced: the quote a person read on screen confirmed,
  // and a mail to a different recipient sent). Waiting in silence is no
  // better for something irreversible - the agent would poll for four hours
  // with nothing on screen, and the human would never learn a send was queued.
  // A refusal with its own line is the only answer that is true when it is
  // given: the person keeps ONE confirmation to read, and the agent is told
  // why, so it can come back after the first one is closed.
  if (busy && !asked) {
    cancelAsk(request.sessionKey, "another confirmation is already open on this card");
    return {
      state: "refused",
      reason: "this card already has a confirmation waiting for an answer: nothing is sent until that one is closed",
    };
  }

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
    clearRoutedAskForSession(request.sessionKey);
    return {
      state: "refused",
      reason: "there is no card thread and no visible tool row to ask on: nobody could confirm",
    };
  }

  try {
    const answers = await waitForAnswer(request.sessionKey, { timeoutMs: request.legMs });
    // THIS QUESTION IS OVER, whatever the answer says. The thread registry is
    // keyed by TASK and does not look at the digest: leaving the entry behind
    // means the NEXT message's question is silently not posted to the card,
    // because the registry still believes one is open. The two existing clears
    // (expiry, and a human answering in the thread) do not cover an answer that
    // arrived through the chat panel.
    clearRoutedAskForSession(request.sessionKey);
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
    clearRoutedAskForSession(request.sessionKey);
    return { state: "refused", reason: err instanceof Error ? err.message : String(err) };
  }
}
