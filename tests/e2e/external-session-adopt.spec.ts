/**
 * external-session-adopt.spec.ts — HANDOFF: adopt a live Claude Code session
 * (started in a terminal) INTO a topic, with its history visible in chat.
 *
 * Attilio's ask: "ho appena passato questa sessione da app claude a terminale su
 * claude code, sarebbe figo che topic fosse nativo in questo". Today a topic
 * STARTS a session; this is the missing opposite direction — take a session
 * already running elsewhere and continue it inside a topic.
 *
 * The test seeds the transcript a bare `claude` would leave under the server's
 * isolated HOME (real scan path, no mocks), then:
 *   ADOPT-01 drives the endpoint directly — bind + import + idempotency.
 *
 * C'era anche un ADOPT-02 che guidava la UI (chip in barra → popover →
 * «Continua qui»). Quel gesto non esiste piu': il chip delle sessioni in
 * terminale e' stato tolto il 13/08, e con lui l'unica superficie da cui si
 * adottava. L'endpoint resta, ed e' quello che questa spec prova. Il `--resume`
 * che fa continuare la STESSA conversazione al turno dopo e' coperto dagli unit
 * test del provider; qui si prova il binding e la storia importata.
 */
import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { claudeProjectDirName } from "../../server/lib/claude-transcript-path";

hermetic(test);

const BASE = E2E_BASE;
const TEST_HOME = E2E_HOME;

// Recognisable markers so we assert the imported history, not some other row.
const USER_MSG = "handoff-domanda-XYZ";
const ASSISTANT_MSG = "handoff-risposta-XYZ";

/** Il server usa questa, e la usa anche il fixture: una regola sola. */
const encode = claudeProjectDirName;

/** Write a transcript with a real user→assistant turn plus a tool call. */
function seedSession(cwd: string, sessionId: string): void {
  const dir = `${TEST_HOME}/.claude/projects/${encode(cwd)}`;
  mkdirSync(dir, { recursive: true });
  const base = { cwd, sessionId, entrypoint: "cli", gitBranch: "main", version: "1.0.0" };
  const lines = [
    { ...base, type: "user", uuid: "u1", timestamp: "2026-07-30T10:00:00Z", message: { role: "user", content: USER_MSG } },
    {
      ...base, type: "assistant", uuid: "a1", timestamp: "2026-07-30T10:00:01Z",
      message: { role: "assistant", content: [
        { type: "text", text: ASSISTANT_MSG },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ] },
    },
    {
      ...base, type: "user", uuid: "u2", timestamp: "2026-07-30T10:00:02Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }] },
    },
  ];
  writeFileSync(`${dir}/${sessionId}.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** Poll until the TTL-cached census surfaces the seeded session. */
async function waitForCensus(request: import("@playwright/test").APIRequestContext, sessionId: string) {
  await expect.poll(async () => {
    const res = await request.get(`${BASE}/api/external-sessions`);
    if (!res.ok()) return null;
    const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
    return body.sessions.find((s) => s.sessionId === sessionId) ?? null;
  }, { timeout: 45_000, intervals: [1000] }).not.toBeNull();
}

test.describe("Handoff: adottare una sessione Claude Code viva", () => {
  test.describe.configure({ timeout: 90_000 });

  const API_PATH = `/tmp/e2e-adopt-api-${Date.now()}`;
  const API_SID = "ad0d7000-1111-2222-3333-444444444444";

  test.beforeAll(async ({ request }) => {
    mkdirSync(API_PATH, { recursive: true });
    writeFileSync(`${API_PATH}/package.json`, JSON.stringify({ name: "e2e-adopt-api" }, null, 2));
    await createTopic(request, "e2e-adopt-api", { projectPath: API_PATH });
    seedSession(API_PATH, API_SID);
  });

  test.afterAll(async () => {
    rmSync(`${TEST_HOME}/.claude/projects/${encode(API_PATH)}`, { recursive: true, force: true });
    rmSync(API_PATH, { recursive: true, force: true });
  });


  test("ADOPT-01: the endpoint binds the session and imports its history", async ({ request }) => {
    await waitForCensus(request, API_SID);

    const res = await request.post(`${BASE}/api/topics/adopt-claude`, { data: { sessionId: API_SID } });
    expect(res.ok()).toBe(true);
    const topic = (await res.json()) as { id: string; sessionKey: string; provider: string; projectPath: string; importedMessages: number };
    expect(topic.provider).toBe("claude-code");
    expect(topic.projectPath).toBe(API_PATH);
    // user + assistant were imported; the tool_result-only line is not a turn.
    expect(topic.importedMessages).toBe(2);

    // History is queryable under the new topic's session — the user's own words,
    // and the assistant reply with its Bash tool call and result.
    const hist = await request.get(`${BASE}/api/history/${encodeURIComponent(topic.sessionKey)}`);
    expect(hist.ok()).toBe(true);
    const { messages } = (await hist.json()) as { messages: Array<{ role: string; content: string; toolCalls?: Array<{ name: string; result?: string }> }> };
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]!.content).toContain(USER_MSG);
    expect(messages[1]!.content).toContain(ASSISTANT_MSG);
    expect(messages[1]!.toolCalls?.[0]).toMatchObject({ name: "Bash", result: "file.txt" });

    // Idempotent: adopting again returns the same topic, no duplicate.
    const again = await request.post(`${BASE}/api/topics/adopt-claude`, { data: { sessionId: API_SID } });
    expect(again.ok()).toBe(true);
    expect(((await again.json()) as { id: string }).id).toBe(topic.id);

    await deleteTopic(request, topic.id);
  });

});
