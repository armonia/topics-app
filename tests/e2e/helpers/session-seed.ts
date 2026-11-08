/**
 * SESSIONS AT WORK, for the specs that look at what a session costs.
 *
 * A session only gets tokens and processes from a live agent, which a spec
 * cannot start. These helpers move the SAME pieces production moves, through the
 * test server's seams (`routes/e2e.ts`): a card in progress bound to a chat
 * topic (as the dispatcher binds it), the tokens of a model round in the
 * native runtime's registry, and a real child process of the server registered
 * as the session's CLI, holding memory and burning a little CPU so the process
 * table has weight to attribute. Nothing is mocked inside Topics: the page
 * reads the real answer.
 */
import { expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { E2E_BASE } from "./test-server";

export interface RunningCard {
  taskId: string;
  boardId: string;
  sessionKey: string;
  /** One model round: adds output tokens to the session's counter. */
  round(output: number): Promise<void>;
  stop(): Promise<void>;
}

export async function seedRunningCard(request: APIRequestContext, o: {
  boardId: string; topicId: string; text: string; model: string;
  holdMB: number; burnPct: number; input: number; output: number; cacheRead: number;
}): Promise<RunningCard> {
  const created = await request.post(`${E2E_BASE}/api/boards/${o.boardId}/tasks`, { data: { text: o.text, status: "in_progress" } });
  expect(created.ok(), await created.text()).toBe(true);
  const taskId = ((await created.json()) as { id: string }).id;
  const bound = await request.post(`${E2E_BASE}/api/test/card-session`, { data: { taskId, topicId: o.topicId, model: o.model } });
  expect(bound.ok(), await bound.text()).toBe(true);
  const { sessionKey } = (await bound.json()) as { sessionKey: string };
  const first = await request.post(`${E2E_BASE}/api/test/session-usage`, {
    data: { sessionKey, model: o.model, spawn: true, holdMB: o.holdMB, burnPct: o.burnPct, input: o.input, output: o.output, cacheRead: o.cacheRead },
  });
  expect(first.ok(), await first.text()).toBe(true);
  // The fixture `request` of a beforeAll cannot be used from a test body, and the rounds
  // run on a timer through the whole test: the card carries a context of its own.
  const own = await playwrightRequest.newContext();
  return {
    taskId, boardId: o.boardId, sessionKey,
    round: async (output) => { await own.post(`${E2E_BASE}/api/test/session-usage`, { data: { sessionKey, model: o.model, output } }).catch(() => {}); },
    stop: async () => {
      await own.post(`${E2E_BASE}/api/test/session-usage`, { data: { sessionKey, stop: true } }).catch(() => {});
      await own.patch(`${E2E_BASE}/api/boards/${o.boardId}/tasks/${taskId}`, { data: { machineId: null } }).catch(() => {});
      await own.delete(`${E2E_BASE}/api/boards/${o.boardId}/tasks/${taskId}`).catch(() => {});
      await own.dispose().catch(() => {});
    },
  };
}

/** Ends a model round on each session every `everyMs`, like turns finishing; returns the stop. */
export function feedRounds(cards: Array<{ card: RunningCard; perRound: number }>, everyMs: number): () => void {
  const timer = setInterval(() => { for (const { card, perRound } of cards) void card.round(perRound); }, everyMs);
  return () => clearInterval(timer);
}
