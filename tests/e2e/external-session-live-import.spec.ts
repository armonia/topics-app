/**
 * external-session-live-import.spec.ts — the adopted chat no longer FREEZES at
 * the adoption snapshot: turns typed in the TERMINAL keep flowing into Topics.
 *
 * The bug: `adopt-claude` read the transcript ONCE and never again for messages,
 * so after adoption the chat was a still photo. The fix persists `jsonl_path` +
 * `import_offset` at adoption and runs an import sweep that re-reads the tail and
 * appends the new turns. This test proves the end-to-end behaviour a unit test
 * can't: adopt a live session, open its chat, then append a fresh turn to the
 * SAME transcript on disk (what a bare `claude` in a terminal does) and watch it
 * appear in the open chat within one sweep. Under E2E_EVIDENCE=1 the run records
 * the .webm that IS the acceptance proof.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, seedProjectPane, seedProjectInnerChats } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, utimesSync } from "fs";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { beat, didascalia } from "./helpers/evidence";
import { claudeProjectDirName } from "../../server/lib/claude-transcript-path";

hermetic(test);

const BASE = E2E_BASE;
const TEST_HOME = E2E_HOME;

// Markers so we assert OUR turns, not some other row.
const HIST_USER = "import-storia-domanda";
const HIST_ASSISTANT = "import-storia-risposta";
const LIVE_USER = "import-live-domanda-DAL-TERMINALE";
const LIVE_ASSISTANT = "import-live-risposta-DAL-TERMINALE";
const FORK_USER = "import-fork-domanda-DOPO-IL-FORK";
const FORK_ASSISTANT = "import-fork-risposta-DOPO-IL-FORK";

/** Il server usa questa, e la usa anche il fixture: una regola sola. */
const encode = claudeProjectDirName;
const transcriptPath = (cwd: string, sessionId: string) =>
  `${TEST_HOME}/.claude/projects/${encode(cwd)}/${sessionId}.jsonl`;

/** One user→assistant turn — the history a bare `claude` already left on disk. */
function seedSession(cwd: string, sessionId: string): void {
  mkdirSync(`${TEST_HOME}/.claude/projects/${encode(cwd)}`, { recursive: true });
  const base = { cwd, sessionId, entrypoint: "cli", gitBranch: "main", version: "1.0.0" };
  const lines = [
    { ...base, type: "user", uuid: "h1", timestamp: "2026-07-30T10:00:00Z", message: { role: "user", content: HIST_USER } },
    { ...base, type: "assistant", uuid: "h2", timestamp: "2026-07-30T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: HIST_ASSISTANT }] } },
  ];
  writeFileSync(transcriptPath(cwd, sessionId), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** Append a NEW turn to the SAME transcript — exactly what continuing the
 *  session in a terminal does. */
function appendTerminalTurn(cwd: string, sessionId: string): void {
  const base = { cwd, sessionId, entrypoint: "cli", gitBranch: "main", version: "1.0.0" };
  const lines = [
    { ...base, type: "user", uuid: "l1", timestamp: "2026-07-30T10:05:00Z", message: { role: "user", content: LIVE_USER } },
    { ...base, type: "assistant", uuid: "l2", timestamp: "2026-07-30T10:05:01Z", message: { role: "assistant", content: [{ type: "text", text: LIVE_ASSISTANT }] } },
  ];
  appendFileSync(transcriptPath(cwd, sessionId), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function waitForCensus(request: import("@playwright/test").APIRequestContext, sessionId: string) {
  await expect.poll(async () => {
    const res = await request.get(`${BASE}/api/external-sessions`);
    if (!res.ok()) return null;
    const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
    return body.sessions.find((s) => s.sessionId === sessionId) ?? null;
  }, { timeout: 45_000, intervals: [1000] }).not.toBeNull();
}

/**
 * ADOTTA E APRI — quello che prima era un gesto in barra.
 *
 * Il chip delle sessioni in terminale (col suo «Continua qui») è stato tolto il
 * 13/08: l'adozione non ha più una superficie, ma ha ancora il suo endpoint, ed
 * è il COMPORTAMENTO DOPO l'adozione che questa spec esiste per provare (i turni
 * dal terminale che continuano ad arrivare nella chat aperta). Quindi il gesto
 * si fa dall'endpoint e la topic si apre come pane: da lì in poi il test è
 * identico a prima, perché la chat è la stessa.
 */
async function adoptAndOpen(
  page: Page,
  request: import("@playwright/test").APIRequestContext,
  cwd: string,
  sessionId: string,
): Promise<string> {
  const res = await request.post(`${BASE}/api/topics/adopt-claude`, { data: { sessionId } });
  expect(res.ok(), "adozione della sessione via endpoint").toBe(true);
  const topic = (await res.json()) as { id: string };
  // La topic adottata è LEGATA al progetto (il cwd della sessione), quindi non
  // vive nella barra principale ma dentro la finestra di quel progetto: il suo
  // layout interno sta server-side (`topics-project-panes-<hash>`) e va seminato
  // prima del caricamento, altrimenti la chat non ha nessuna tab da cui aprirsi.
  await seedProjectInnerChats(request, cwd, [topic.id]);
  await seedProjectPane(request, cwd).catch(() => {});
  await page.goto("/");
  await expect(page.getByTestId("project-window")).toBeVisible({ timeout: 20000 });
  return topic.id;
}

/** Il fork: `--resume` riapre un file NUOVO e ci ricopia la storia (stessi uuid),
 *  poi ci scrive il turno nuovo. Il file vecchio non cresce più. */
function forkSession(cwd: string, parentSid: string, childSid: string): string {
  const base = { cwd, sessionId: childSid, entrypoint: "cli", gitBranch: "main", version: "1.0.0" };
  const copied = [
    { ...base, type: "user", uuid: "h1", timestamp: "2026-07-30T10:00:00Z", message: { role: "user", content: HIST_USER } },
    { ...base, type: "assistant", uuid: "h2", timestamp: "2026-07-30T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: HIST_ASSISTANT }] } },
  ];
  const fresh = [
    { ...base, type: "user", uuid: "f1", timestamp: "2026-07-30T11:00:00Z", message: { role: "user", content: FORK_USER } },
    { ...base, type: "assistant", uuid: "f2", timestamp: "2026-07-30T11:00:01Z", message: { role: "assistant", content: [{ type: "text", text: FORK_ASSISTANT }] } },
  ];
  const path = transcriptPath(cwd, childSid);
  writeFileSync(path, [...copied, ...fresh].map((l) => JSON.stringify(l)).join("\n") + "\n");
  // Il padre ha smesso di crescere: lo sweep guarda solo i transcript FERMI.
  const stale = Date.now() / 1000 - 120;
  utimesSync(transcriptPath(cwd, parentSid), stale, stale);
  return path;
}

test.describe("Sessione adottata: i turni dal terminale continuano ad arrivare", () => {
  test.describe.configure({ timeout: 90_000 });

  const CWD = `/tmp/e2e-live-import-${Date.now()}`;
  const SID = "ad0d7000-9999-8888-7777-666666666666";

  test.beforeAll(async ({ request }) => {
    mkdirSync(CWD, { recursive: true });
    writeFileSync(`${CWD}/package.json`, JSON.stringify({ name: "e2e-live-import" }, null, 2));
    await createTopic(request, "e2e-live-import", { projectPath: CWD });
    seedSession(CWD, SID);
  });

  test.afterAll(async () => {
    rmSync(`${TEST_HOME}/.claude/projects/${encode(CWD)}`, { recursive: true, force: true });
    rmSync(CWD, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
  });

  test("a terminal turn appears in the adopted chat within one sweep", async ({ page, request }) => {
    await waitForCensus(request, SID);

    const topicId = await adoptAndOpen(page, request, CWD, SID);

    await expect(page.getByTestId("message-content-user").filter({ hasText: HIST_USER })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("message-content-assistant").filter({ hasText: HIST_ASSISTANT })).toBeVisible({ timeout: 20000 });

    // THE PROOF: continue the session in the terminal — a fresh turn is appended
    // to the SAME transcript on disk. Topics wasn't told; only the JSONL grew.
    appendTerminalTurn(CWD, SID);

    // The import sweep (≤1.5s interval) picks it up and the open chat appends it
    // live via `message:new`. No reload, no user action.
    await expect(page.getByTestId("message-content-user").filter({ hasText: LIVE_USER })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("message-content-assistant").filter({ hasText: LIVE_ASSISTANT })).toBeVisible({ timeout: 20000 });

    await deleteTopic(request, topicId).catch(() => {});
  });
});

test.describe("Sessione adottata: la chat SEGUE il fork del transcript", () => {
  test.describe.configure({ timeout: 120_000 });
  // Clip di consegna: sotto la soglia di taglio della card (760/1440 = 0.528).
  test.use({ viewport: { width: 1440, height: 760 } });

  const CWD = `/tmp/e2e-fork-import-${Date.now()}`;
  const SID = "bb0d7000-1111-2222-3333-444444444444";
  const CHILD_SID = "ff0d7000-5555-6666-7777-888888888888";

  test.beforeAll(async ({ request }) => {
    mkdirSync(CWD, { recursive: true });
    writeFileSync(`${CWD}/package.json`, JSON.stringify({ name: "e2e-fork-import" }, null, 2));
    await createTopic(request, "e2e-fork-import", { projectPath: CWD });
    seedSession(CWD, SID);
  });

  test.afterAll(async () => {
    rmSync(`${TEST_HOME}/.claude/projects/${encode(CWD)}`, { recursive: true, force: true });
    rmSync(CWD, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
  });

  test("il resume riparte da un NUOVO file: la chat non si ricongela", async ({ page, request }) => {
    await waitForCensus(request, SID);

    const topicId = await adoptAndOpen(page, request, CWD, SID);

    // Stato 1 — la chat adottata mostra la storia.
    await expect(page.getByTestId("message-content-user").filter({ hasText: HIST_USER })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("message-content-assistant").filter({ hasText: HIST_ASSISTANT })).toBeVisible({ timeout: 20000 });
    await didascalia(page, "1 · sessione adottata, la storia è nella chat");
    await beat(page, 2000);

    // LA PROVA: il resume FORKA. Il file che stiamo seguendo muore lì; la
    // sessione continua in <nuovo-id>.jsonl, che ricopia la storia (stessi uuid)
    // e ci aggiunge il turno nuovo. Nessuno lo dice a Topics.
    forkSession(CWD, SID, CHILD_SID);
    await didascalia(page, "2 · il resume FORKA: nuovo .jsonl, il vecchio è morto");
    await beat(page, 2000);

    // Stato 2 — lo sweep riconosce la copia, si riaggancia al file nuovo e il
    // turno post-fork compare nella chat aperta. Senza il fix resterebbe vuota.
    await expect(page.getByTestId("message-content-user").filter({ hasText: FORK_USER })).toBeVisible({ timeout: 45000 });
    await expect(page.getByTestId("message-content-assistant").filter({ hasText: FORK_ASSISTANT })).toBeVisible({ timeout: 45000 });
    await didascalia(page, "3 · il turno post-fork arriva: chat NON congelata");
    await beat(page, 2500);
    // La storia ricopiata NON è stata reimportata: un solo esemplare a testa.
    await expect(page.getByTestId("message-content-user").filter({ hasText: HIST_USER })).toHaveCount(1);

    await deleteTopic(request, topicId).catch(() => {});
  });
});
