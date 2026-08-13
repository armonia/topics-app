/**
 * external-sessions.spec.ts — the Claude sessions Topics did NOT start show up
 * on the board.
 *
 * Topics only knows the sessions it spawned, so a repo worked by hand from a
 * terminal reads as "fermo" on the kanban. The server takes a census of
 * `~/.claude/projects/*.jsonl` (see server/lib/external-claude-sessions.ts).
 *
 * Il censimento non ha piu' una superficie: il chip in barra alla kanban e'
 * stato tolto il 13/08 (era un numero che non chiedeva niente a chi lo
 * leggeva). Il lettore che resta e' il dispatcher, che di qui sa quando un
 * repo e' gia' lavorato a mano da qualcun altro. Quindi la prova e' sul DATO,
 * non su un pixel.
 *
 * The test server runs with HOME=<DATA_DIR>/.home (see
 * scripts/start-test-server.sh), so seeding a transcript under THAT home is
 * exactly what a bare `claude` would write — no mocks, the real scan path.
 */
import { test } from "./fixtures/layout.fixture";
import { expect } from "@playwright/test";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { claudeProjectDirName } from "../../server/lib/claude-transcript-path";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;
const TEST_HOME = E2E_HOME;
const PROJECT_PATH = `/tmp/e2e-extsess-${Date.now()}`;
/** Il server usa questa, e la usa anche il fixture: una regola sola. */
const encodedDir = claudeProjectDirName(PROJECT_PATH);
const TRANSCRIPT_DIR = `${TEST_HOME}/.claude/projects/${encodedDir}`;
const SESSION_ID = "e2e11111-2222-3333-4444-555555555555";

let projectTopicId: string | null = null;

/** Write the transcript a bare `claude` session would leave behind. */
function seedExternalSession(cwd = PROJECT_PATH, branch = "main"): void {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const entry = {
    type: "user",
    uuid: "u1",
    timestamp: new Date().toISOString(),
    cwd,
    sessionId: SESSION_ID,
    entrypoint: "cli",
    gitBranch: branch,
    message: { role: "user", content: "ciao" },
  };
  writeFileSync(`${TRANSCRIPT_DIR}/${SESSION_ID}.jsonl`, JSON.stringify(entry) + "\n");
}

test.describe("Sessioni Claude fuori dalla kanban", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ request }) => {
    mkdirSync(PROJECT_PATH, { recursive: true });
    writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-extsess" }, null, 2));
    // The topic gives the project a path the server already knows, so the
    // census can attribute the session's cwd to this board.
    const topic = await createTopic(request, "E2E-ExtSess", { projectPath: PROJECT_PATH });
    projectTopicId = topic.id;
    seedExternalSession();
  });

  test.afterAll(async ({ request }) => {
    if (projectTopicId) await deleteTopic(request, projectTopicId);
    rmSync(TRANSCRIPT_DIR, { recursive: true, force: true });
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });


  test("EXTSESS-01: /api/external-sessions reports the bare session with project, branch and last activity", async ({ request }) => {
    // The census is TTL-cached server-side; poll until the seeded transcript
    // lands (this is also the "entro un minuto" acceptance criterion).
    await expect.poll(async () => {
      const res = await request.get(`${BASE}/api/external-sessions`);
      if (!res.ok()) return null;
      const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
      return body.sessions.find((s) => s.sessionId === SESSION_ID) ?? null;
    }, { timeout: 45_000, intervals: [1000] }).not.toBeNull();

    const res = await request.get(`${BASE}/api/external-sessions`);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string; cwd: string; projectPath: string | null; branch: string | null; state: string; lastActivityMs: number }>;
      projects: Array<{ projectPath: string; active: number }>;
    };
    const mine = body.sessions.find((s) => s.sessionId === SESSION_ID)!;
    expect(mine.cwd).toBe(PROJECT_PATH);
    expect(mine.projectPath).toBe(PROJECT_PATH);
    expect(mine.branch).toBe("main");
    expect(mine.state).toBe("active");
    expect(body.projects.some((p) => p.projectPath === PROJECT_PATH && p.active >= 1)).toBe(true);
  });

});
