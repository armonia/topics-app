/**
 * A SERVER RESTART LOSES NOTHING OF THE NATIVE TURNS IN FLIGHT (lossless-restart).
 *
 * The native runtime (`topics`, the default for chats and cards) used to run
 * each turn inside the server: every restart aborted it, the chat showed the
 * restart notice and the card redid its turn. Each turn now runs in its own
 * process under the AI broker (`server/providers/native/turn-host.ts`), and the
 * next server finds it again from the broker's journal.
 *
 * Three native turns are in flight at once: a chat streaming a long answer, a
 * card dispatched on a board, and a chat whose model asked a question. The
 * server is SIGTERMed and relaunched (`restartTestServer`, as the file watcher
 * does in production). Then, with no page reload and nobody pressing Riprova:
 * the chat bubble is the same row and ends with every piece once and in order,
 * the model was asked each round exactly once, the card ends on its session
 * with no attempt spent, and the question, still on screen, is answered after
 * the restart and reaches the model as the result of the same `tool_use`.
 *
 * The model is `helpers/fake-anthropic-api.ts`, which lives in the Playwright
 * process and so survives the restart; it streams one piece every 300 ms.
 *
 * Bar of openspec/changes/lossless-restart/specs/acceptance.md.
 *
 * @covers RESUME-06
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectIdForPath } from "../../shared/board";
import { hermetic } from "./fixtures/hermetic";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTask, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME, testServerEnv } from "./helpers/test-server";
import { restartTestServer } from "./helpers/restart-test-server";
import { installFakeAnthropic, startFakeAnthropic, type FakeAnthropic, type FakeRound } from "./helpers/fake-anthropic-api";
import { beat, didascalia } from "./helpers/evidence";
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 240_000 });

const CHAT_PIECES = 30;
const CARD_PIECES = 100;
const PIECE_MS = 300;
const NATIVE_MODEL = "claude-sonnet-5-5";

const SCRIPTS: Record<string, FakeRound[]> = {
  stream: [{ textPieces: CHAT_PIECES, pieceMs: PIECE_MS }],
  card: [{ textPieces: CARD_PIECES, pieceMs: PIECE_MS }],
  ask: [{
    tools: [{
      name: "ask_user_question",
      input: { questions: [{ question: "Quale strada prendo?", header: "Strada", options: [{ label: "Uno" }, { label: "Due" }], multiSelect: false }] },
    }],
  }],
};

const PROJECT_PATH = join(realpathSync(canonicalTmpRoot()), `e2e-lossless-${Date.now()}`);
const PROJECT_ID = projectIdForPath(PROJECT_PATH);

type Msg = { id: string; role: string; content: string };

/** The piece numbers in `text`, in the order they appear (`«i»` per piece). */
function piecesIn(text: string): number[] {
  return [...text.matchAll(/«(\d+)»/g)].map((m) => Number(m[1]));
}

const oneToN = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** Registers or removes the native runtime on the running bench (`/api/test/native-runtime`). */
async function nativeRuntime(body: { on: boolean; workspace?: string }): Promise<unknown> {
  const res = await fetch(`${E2E_BASE}/api/test/native-runtime`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function nativeChat(request: APIRequestContext, name: string): Promise<{ id: string; name: string; sessionKey: string }> {
  const topic = await createTopic(request, name);
  await patchTopic(request, topic.id, { provider: "topics" });
  const sessionKey = (await (await request.get(`${E2E_BASE}/api/topics/${topic.id}`)).json()).topic.sessionKey as string;
  return { id: topic.id, name, sessionKey };
}

async function messagesOf(request: APIRequestContext, topicId: string): Promise<Msg[]> {
  const res = await request.get(`${E2E_BASE}/api/topics/${topicId}/messages?limit=50`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { messages: Msg[] }).messages;
}

/** The session's rows as `GET /api/history/:sessionKey` sends them: a turn's row while it streams included. */
async function historyOf(request: APIRequestContext, sessionKey: string): Promise<Msg[]> {
  const res = await request.get(`${E2E_BASE}/api/history/${encodeURIComponent(sessionKey)}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { messages: Msg[] }).messages;
}

type TaskSnapshot = {
  task: { status: string; dispatchState: string | null; assignedTopicId: string | null; dispatchAttempts: number };
  comments: Array<{ content: string }>;
};

async function readTask(request: APIRequestContext, taskId: string): Promise<TaskSnapshot> {
  const res = await request.get(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json() as Promise<TaskSnapshot>;
}

/** `/__daemon/healthz` with the daemon token the test server wrote in its TOPICS_HOME. */
async function healthz(): Promise<{ status: number; body: { pid?: number; losslessRestart?: boolean } | null }> {
  let token = "";
  try { token = JSON.parse(readFileSync(join(testServerEnv().TOPICS_HOME!, "daemon-state.json"), "utf8")).token ?? ""; } catch { /* no state: 401 below */ }
  const res = await fetch(`${E2E_BASE}/__daemon/healthz`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res) return { status: 0, body: null };
  return { status: res.status, body: res.ok ? await res.json() : null };
}

/** What the database says about each tool call of a session: for a failure message. */
async function storedCalls(request: APIRequestContext, sessionKey: string): Promise<string> {
  const body = await (await request.get(`${E2E_BASE}/api/history/${encodeURIComponent(sessionKey)}`)).json() as {
    messages: Array<{ role: string; blocks?: Array<{ kind: string; toolCall?: { id: string; status?: string } }> }>;
  };
  return JSON.stringify(body.messages.filter((m) => m.role === "assistant").flatMap((m) =>
    (m.blocks ?? []).flatMap((b) => (b.kind === "tool" && b.toolCall ? [`${b.toolCall.id}:${b.toolCall.status}`] : []))));
}

function chatPanel(page: Page, topicId: string) {
  return page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${topicId}"]`);
}

function lastAssistant(page: Page, topicId: string) {
  return chatPanel(page, topicId).locator('[data-testid="chat-message"][data-role="assistant"]').last();
}

async function openChatPage(page: Page, name: string, topicId: string): Promise<void> {
  await goToApp(page);
  // No Escape here, unlike the other native specs: on a chat whose turn is
  // running Escape is Stop, and the window opened second lands on the chat
  // whose question is waiting.
  await openTopic(page, new RegExp(name));
  await expect(chatPanel(page, topicId)).toBeVisible({ timeout: 20_000 });
}

async function send(page: Page, topicId: string, text: string): Promise<void> {
  const input = chatPanel(page, topicId).getByRole("textbox", { name: /Campo del messaggio|Message input for/ });
  await input.fill(text);
  await input.press("Control+Enter");
}

test("three native turns in flight survive a server restart, nothing redone and nothing lost @nightly", async ({ page, context, request }) => {
  test.info().annotations.push({ type: "spec", description: "RESUME-06" });
  const stamp = Date.now();
  let fake: FakeAnthropic | null = null;
  let undoFake: (() => void) | null = null;
  let workspace = "";
  let projectId: string | null = null;
  let taskId: string | null = null;
  let boundTopic: string | null = null;
  let originalSettings: { autoDispatch: boolean; dispatchUseWorktree: boolean } | null = null;
  const topics: string[] = [];

  try {
    fake = await startFakeAnthropic(SCRIPTS);
    undoFake = installFakeAnthropic(E2E_HOME, fake.baseUrl);
    workspace = mkdtempSync(join(tmpdir(), "lossless-restart-"));
    expect(await nativeRuntime({ on: true, workspace })).toEqual({ ok: true, connected: true });

    const streamChat = await nativeChat(request, `lossless-stream-${stamp}`);
    const askChat = await nativeChat(request, `lossless-ask-${stamp}`);
    topics.push(streamChat.id, askChat.id);
    await resetPaneStore(request, [streamChat.id, askChat.id]);

    // ── The card: a board with dispatch on, a native model, a slow round. ──
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(join(PROJECT_PATH, "package.json"), JSON.stringify({ name: `e2e-lossless-${stamp}` }));
    const registered = await request.post(`${E2E_BASE}/api/projects`, { data: { name: `e2e-lossless-${stamp}`, path: PROJECT_PATH } });
    expect(registered.ok(), await registered.text()).toBeTruthy();
    projectId = ((await registered.json()) as { id: string }).id;
    const settings = await request.get(`${E2E_BASE}/api/boards/${PROJECT_ID}/settings`);
    expect(settings.ok(), await settings.text()).toBeTruthy();
    originalSettings = await settings.json() as { autoDispatch: boolean; dispatchUseWorktree: boolean };
    const enabled = await request.patch(`${E2E_BASE}/api/boards/${PROJECT_ID}/settings`, { data: { autoDispatch: true, dispatchUseWorktree: false } });
    expect(enabled.ok(), await enabled.text()).toBeTruthy();
    const created = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
      data: { text: `Rispondi per esteso SCEN:card ${stamp}`, status: "todo", model: `topics:${NATIVE_MODEL}` },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    taskId = ((await created.json()) as { id: string }).id;
    await expect.poll(async () => (await readTask(request, taskId!)).task.dispatchState, {
      timeout: 45_000, message: "the dispatcher started the card's turn",
    }).toBe("working");
    const before = await readTask(request, taskId);
    boundTopic = before.task.assignedTopicId;
    expect(boundTopic, "the card is bound to its agent's session").toBeTruthy();
    topics.push(boundTopic!);
    const cardPieces = async () => piecesIn((await messagesOf(request, boundTopic!)).filter((m) => m.role === "assistant").map((m) => m.content).join("\n"));
    await expect.poll(async () => (await cardPieces()).length, { timeout: 30_000, message: "the card's turn is under way" }).toBeGreaterThanOrEqual(3);

    // ── The question: its panel open in a window of its own. ──
    const askPage = await context.newPage();
    await openChatPage(askPage, askChat.name, askChat.id);
    await send(askPage, askChat.id, "SCEN:ask scegli tu");
    const question = chatPanel(askPage, askChat.id).locator('[data-testid^="tool-call-row-"][data-status="waiting_for_input"]');
    await expect(question).toHaveCount(1, { timeout: 30_000 });
    await expect(question.locator('[data-testid^="tool-input-form-"]')).toBeVisible();
    const askRound0 = fake.requests.find((r) => r.scen === "ask" && r.round === 0);
    expect(askRound0?.toolUseIds, "the model asked with one tool_use").toHaveLength(1);
    const toolUseId = askRound0!.toolUseIds[0]!;
    await expect(question).toHaveAttribute("data-testid", `tool-call-row-${toolUseId}`);

    // ── The long answer: at least 8 pieces on screen. ──
    await openChatPage(page, streamChat.name, streamChat.id);
    let pageLoads = 0;
    page.on("load", () => { pageLoads += 1; });
    let askPageLoads = 0;
    askPage.on("load", () => { askPageLoads += 1; });
    await send(page, streamChat.id, "SCEN:stream scrivi a lungo");
    const bubble = lastAssistant(page, streamChat.id);
    await expect.poll(async () => piecesIn((await bubble.textContent().catch(() => "")) ?? "").length, {
      timeout: 30_000, intervals: [100], message: "8 pieces of the answer are on screen",
    }).toBeGreaterThanOrEqual(8);
    // The row of the turn, as the server keeps it: the sender's bubble may
    // still carry its own provisional id until the turn ends.
    const rowsBefore = (await historyOf(request, streamChat.sessionKey)).filter((m) => m.role === "assistant");
    expect(rowsBefore, "the turn has one assistant row in the database").toHaveLength(1);
    const rowBefore = rowsBefore[0]!.id;
    const shownBefore = piecesIn((await bubble.textContent()) ?? "");
    await expect(question, `the question is still open when the server goes down (stored: ${await storedCalls(request, askChat.sessionKey)}, panel: ${await chatPanel(askPage, askChat.id).count()})`).toHaveCount(1);
    expect((await readTask(request, taskId)).task.dispatchState, "the card is still mid-turn").toBe("working");
    await didascalia(page, `Tre turni in volo: ${shownBefore.length} pezzi sullo schermo, una card, una domanda aperta`);

    // ── SIGTERM and relaunch. ──
    const healthBefore = await healthz();
    expect(healthBefore.status, "the old server answers /__daemon/healthz").toBe(200);
    const sigtermAt = Date.now();
    const bootLog = await restartTestServer();
    let health = await healthz();
    while (health.status !== 200 && Date.now() - sigtermAt < 10_000) {
      await new Promise((r) => setTimeout(r, 100));
      health = await healthz();
    }
    const backAfterMs = Date.now() - sigtermAt;
    console.log(`[restart-loses-nothing] /__daemon/healthz answered ${backAfterMs} ms after the SIGTERM (status ${health.status}, pid ${healthBefore.body?.pid} -> ${health.body?.pid})`);
    test.info().annotations.push({ type: "restart-ms", description: String(backAfterMs) });
    expect(health.status, "the new server answers /__daemon/healthz").toBe(200);
    expect(health.body?.pid, "it is a new process").not.toBe(healthBefore.body?.pid);
    expect(health.body?.losslessRestart, "the new server says a restart loses no turn").toBe(true);
    expect(backAfterMs, "the server is back within 5 s of the SIGTERM").toBeLessThanOrEqual(5_000);

    // ── The chat: same row, every piece once, in order. ──
    await expect.poll(async () => piecesIn((await bubble.textContent().catch(() => "")) ?? "").length, {
      timeout: 60_000, intervals: [250], message: "the bubble ends with the whole answer",
    }).toBeGreaterThanOrEqual(CHAT_PIECES);
    await expect(bubble.locator('[data-testid="stream-token-rate"]')).toHaveAttribute("data-streaming", "false", { timeout: 20_000 });
    expect(piecesIn((await bubble.textContent()) ?? ""), "every piece once, in order").toEqual(oneToN(CHAT_PIECES));
    await expect(bubble, "the bubble on screen is the row the turn started in").toHaveAttribute("data-message-id", rowBefore);
    await expect(chatPanel(page, streamChat.id).locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(1);
    const streamStored = (await historyOf(request, streamChat.sessionKey)).filter((m) => m.role === "assistant");
    expect(streamStored.map((m) => m.id), "one assistant row in the database, the same one").toEqual([rowBefore]);
    expect(piecesIn(streamStored[0]!.content), "the stored answer is whole").toEqual(oneToN(CHAT_PIECES));
    await didascalia(page, "Dopo il riavvio la stessa bolla arriva in fondo, ogni pezzo una volta");
    await beat(page, 900);

    // ── The question: still there, answered now, delivered to the same tool_use. ──
    await expect(question, "the question panel is still open after the restart").toHaveCount(1, { timeout: 20_000 });
    const form = question.locator('[data-testid^="tool-input-form-"]');
    await expect(form).toBeVisible();
    await form.locator('input[type="radio"][value="Due"]').check();
    await form.getByTestId("ask-submit").click();
    await expect(chatPanel(askPage, askChat.id).getByText("FINE-ask").first()).toBeVisible({ timeout: 45_000 });
    const askRound1 = fake.requests.filter((r) => r.scen === "ask" && r.round === 1);
    expect(askRound1, "the round after the answer was asked once").toHaveLength(1);
    const lastUser = [...askRound1[0]!.messages].reverse().find((m) => m.role === "user");
    const results = (Array.isArray(lastUser?.content) ? lastUser!.content : []) as Array<{ type?: string; tool_use_id?: string; content?: unknown }>;
    const result = results.find((b) => b.type === "tool_result");
    expect(result?.tool_use_id, "the answer goes back as the result of the same tool_use").toBe(toolUseId);
    expect(JSON.stringify(result?.content ?? ""), "the result carries the answer given after the restart").toContain("Due");

    // ── The card: ends on its session, no attempt spent. ──
    const cardSession = `topic:${boundTopic!.slice(0, 8)}`;
    const delivered = await request.patch(`${E2E_BASE}/api/sessions/${encodeURIComponent(cardSession)}/tasks/${taskId}`, {
      data: { status: "review", summary: "Il turno della card è arrivato in fondo dopo il riavvio." },
    });
    expect(delivered.ok(), await delivered.text()).toBeTruthy();
    await expect.poll(async () => (await cardPieces()).length, {
      timeout: 60_000, intervals: [500], message: "the card's turn writes its whole answer",
    }).toBeGreaterThanOrEqual(CARD_PIECES);
    expect(await cardPieces(), "the card's answer is whole, nothing written twice").toEqual(oneToN(CARD_PIECES));
    await expect.poll(async () => (await readTask(request, taskId!)).task.status, {
      timeout: 60_000, message: "the card reaches review",
    }).toBe("review");
    const after = await readTask(request, taskId);
    expect(after.task.assignedTopicId, "the card stays on its session").toBe(boundTopic);
    expect(after.task.dispatchAttempts, "the restart spends no attempt").toBe(before.task.dispatchAttempts);

    // ── The model served each round once: nothing regenerated, nothing paid twice. ──
    const served = new Map<string, number>();
    for (const r of fake.requests) if (r.scen) served.set(`${r.scen}:${r.round}`, (served.get(`${r.scen}:${r.round}`) ?? 0) + 1);
    const twice = [...served].filter(([, n]) => n > 1);
    expect(twice, `rounds served more than once (all: ${JSON.stringify([...served])})`).toEqual([]);
    expect(served.get("stream:0")).toBe(1);
    expect(served.get("card:0")).toBe(1);
    expect(served.get("ask:0")).toBe(1);

    // ── Nobody saw the restart. ──
    for (const id of [streamChat.id, askChat.id, boundTopic!]) {
      const notices = (await messagesOf(request, id)).filter((m) => m.content.includes("Turno interrotto"));
      expect(notices, `no restart notice in ${id}`).toEqual([]);
    }
    for (const p of [page, askPage]) {
      await expect(p.getByText("Turno interrotto")).toHaveCount(0);
      await expect(p.getByRole("button", { name: /Riprova/ })).toHaveCount(0);
    }
    expect(pageLoads, "the chat window was never reloaded").toBe(0);
    expect(askPageLoads, "the question window was never reloaded").toBe(0);
    const bootLines = bootLog.join("").split("\n");
    console.log(`[restart-loses-nothing] new server:\n${bootLines.filter((l) => /partial sweep|chat-reattach|reattach|ripres|native-detached/i.test(l)).map((l) => `  ${l.slice(0, 240)}`).join("\n")}`);
    console.log(`[restart-loses-nothing] rounds served: ${JSON.stringify([...served])}`);
    expect(bootLog.join(""), "the boot closed no partial row").toContain("partial sweep: reset 0,");
    await didascalia(page, "Nessun turno interrotto, nessun Riprova: il riavvio non si è visto");
    await beat(page, 1200);
  } finally {
    if (originalSettings) {
      await request.patch(`${E2E_BASE}/api/boards/${PROJECT_ID}/settings`, {
        data: { autoDispatch: originalSettings.autoDispatch, dispatchUseWorktree: originalSettings.dispatchUseWorktree },
      }).catch(() => {});
    }
    if (taskId) await deleteTask(request, PROJECT_ID, taskId).catch(() => {});
    for (const id of topics) await deleteTopic(request, id).catch(() => {});
    if (projectId) await request.delete(`${E2E_BASE}/api/projects/${projectId}`).catch(() => {});
    await nativeRuntime({ on: false }).catch(() => {});
    undoFake?.();
    await fake?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    removeTmpDir(PROJECT_PATH);
  }
});
