/**
 * FASE 2 — i tre stati di una tab, e il raggruppamento per stato.
 *
 * Perché questa spec esiste. Tutta la catena fase → tier → colore era verificata
 * SOLO a livello unit: un `grep session:state tests/e2e/` dava zero, cioè nessuno
 * spec E2E ha mai messo una sessione in 'awaiting-approval' o in 'running' per
 * guardare cosa fa la UI. Qui lo si fa, e col VIDEO: la differenza fra i due tier
 * è tinta + velocità di respiro, e un tick verde non la dimostra a nessuno.
 *
 * I tre stati:
 *   - awaiting-approval → tier 'input', ambra: "attende una tua risposta"
 *   - awaiting-user     → tier 'done',  blu:  "turno finito"
 *   - running           → nessun tier, spinner: "al lavoro"
 *
 * Le fasi si iniettano come frame `session:state` sulla connessione intercettata
 * (helpers/ws-helpers). Il `sessionKey` NON si indovina dalla convenzione: si
 * legge dall'API, così un cambio di formato rompe il seed in modo evidente invece
 * di produrre bucket vuoti che sembrano un test verde.
 */
import { test, expect } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { attentionUpdated } from "./helpers/attention";
import IT from "../../client/src/lib/i18n-it";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

// Video: la prova che serve qui è visiva (due ambre/blu che respirano a velocità
// diverse, tre sezioni che compaiono). `test.use({ video: 'on' })` sulla singola
// spec, NON E2E_EVIDENCE=1 — quello accende anche slowMo:300 su TUTTA la suite.
test.use({ video: "on" });

interface Seeded { id: string; name: string; sessionKey: string }

test.describe("Stato delle tab: i tre stati e il raggruppamento", () => {
  let attende: Seeded;
  let finito: Seeded;
  let lavora: Seeded;

  /** Il sessionKey che il SERVER ha assegnato a questa topic. */
  async function sessionKeyOf(request: import("@playwright/test").APIRequestContext, topicId: string): Promise<string> {
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const body = await res.json();
    // `TopicsData.topics` è una MAPPA id→Topic, non un array (shared/types.ts:481).
    const map: Record<string, { id: string; sessionKey?: string }> = body.topics ?? {};
    const found = map[topicId];
    if (!found?.sessionKey) {
      throw new Error(`la topic ${topicId} non ha sessionKey: il seed delle fasi non può funzionare`);
    }
    return found.sessionKey;
  }

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    const mk = async (suffix: string): Promise<Seeded> => {
      const name = `stato-${suffix}-${stamp}`;
      const t = await createTopic(request, name);
      return { id: t.id, name, sessionKey: await sessionKeyOf(request, t.id) };
    };
    attende = await mk("attende");
    finito = await mk("finito");
    lavora = await mk("lavora");
  });

  test.afterAll(async ({ request }) => {
    for (const s of [attende, finito, lavora]) {
      if (s?.id) await deleteTopic(request, s.id).catch(() => {});
    }
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [attende.id, finito.id, lavora.id]);
  });

  test("i tre stati si distinguono su tab e righe", async ({ page }) => {

    test.info().annotations.push({ type: "spec", description: "CHROME-07" });
    // L'intercetto va installato PRIMA del goto, o la connessione iniziale sfugge.
    const ws = await interceptWebSocket(page);
    await goToApp(page);

    // Le tre tab esistono prima di parlare di stato.
    const tabs = page.locator('[role="tab"][data-pane-id]');
    await expect(tabs.first()).toBeVisible({ timeout: 15000 });

    await expect.poll(() => ws.getByType("attention:init").length, { timeout: 15000 }).toBeGreaterThan(0);
    ws.send(attentionUpdated(`topic:${attende.id}`, { state: "needs-you", reason: "permission" }));
    ws.send(attentionUpdated(`topic:${finito.id}`, { state: "finished" }));
    ws.send(attentionUpdated(`topic:${lavora.id}`, { state: "working" }));

    // `data-attention` è l'appiglio dichiarato dello stato (le classi Tailwind non
    // lo sono: rinominarne una faceva passare i vecchi locator a verde-vuoto).
    const tabAttende = page.locator('[role="tab"][data-attention="needs-you"]');
    const tabFinito = page.locator('[role="tab"][data-attention="done"]');
    await expect(tabAttende.first()).toBeVisible({ timeout: 15000 });
    await expect(tabFinito.first()).toBeVisible({ timeout: 15000 });

    // Lo stato si dice anche a PAROLE — prima non era detto da nessuna parte, e
    // per chi non vede il colore la tab era muta.
    // Through the catalogue, never a literal (tests/e2e/CONVENTIONS.md).
    await expect(page.getByRole("tab", { name: new RegExp(IT["attention.state.needsYou"]) }).first()).toBeVisible();
    await expect(page.getByRole("tab", { name: new RegExp(IT["attention.state.done"]) }).first()).toBeVisible();

    // "Al lavoro" NON è un tier: nessun fondo colorato, quindi nessun
    // data-attention. È la distinzione fra i due assi.
    const tabLavora = page.locator(`[role="tab"]`, { hasText: new RegExp(lavora.name) });
    await expect(tabLavora.first()).not.toHaveAttribute("data-attention", /.+/);
  });

  test("la vista per stato raggruppa in Attende te / Al lavoro / Il resto", async ({ page }) => {
    const ws = await interceptWebSocket(page);
    // La vista si semina nello storage invece di guidare il menu: il toggle vive
    // dentro un popover della sidebar, e aprirlo a click renderebbe questo test
    // una prova del menu, non del raggruppamento. `topics-sidebar-state` è la
    // fonte primaria del client (useSidebarState).
    await page.addInitScript(() => {
      try {
        const raw = window.localStorage.getItem('topics-sidebar-state');
        const prev = raw ? JSON.parse(raw) : {};
        window.localStorage.setItem('topics-sidebar-state', JSON.stringify({ ...prev, viewMode: 'state' }));
      } catch { /* storage non disponibile: il test fallirà sull'assert, non qui */ }
    });
    await goToApp(page);
    await expect(page.locator('[role="tab"][data-pane-id]').first()).toBeVisible({ timeout: 15000 });

    await expect.poll(() => ws.getByType("attention:init").length, { timeout: 15000 }).toBeGreaterThan(0);
    ws.send(attentionUpdated(`topic:${attende.id}`, { state: "needs-you", reason: "permission" }));
    ws.send(attentionUpdated(`topic:${finito.id}`, { state: "finished" }));
    ws.send(attentionUpdated(`topic:${lavora.id}`, { state: "working" }));
    await expect(page.locator('[role="tab"][data-attention="needs-you"]').first()).toBeVisible({ timeout: 15000 });

    // Le sezioni, dallo stesso tier (ATTN-12): «Ti aspetta», «Finite», «Al
    // lavoro»; una sezione vuota non si disegna.
    const attesa = page.locator('[data-testid="sidebar-state-section-needs-you"]');
    await expect(attesa).toBeVisible({ timeout: 10000 });
    await expect(attesa).toContainText(attende.name);
    await expect(attesa).not.toContainText(finito.name);
    await expect(page.locator('[data-testid="sidebar-state-section-finished"]')).toContainText(finito.name);
    await expect(page.locator('[data-testid="sidebar-state-section-working"]')).toContainText(lavora.name);
  });

  test("una domanda dentro l'app sta in Attende te, non in Al lavoro", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-07" });
    // A chat of the default runtime parked on `ask_user_question`: the turn is
    // still open (so it is also a working stream), and the question reaches
    // the client only as `waiting` in the streams snapshot. The view used to
    // read the hook phases alone and filed it with the working ones.
    const name = `stato-domanda-${Date.now()}`;
    const t = await createTopic(request, name);
    try {
      const sessionKey = await sessionKeyOf(request, t.id);
      // Seeded before the load: the first snapshot already reads `waiting`.
      expect((await request.post(`${BASE}/api/test/streams/partial`, { data: { sessionKey } })).ok()).toBe(true);
      const question = "Procedo?";
      const options = [{ label: "si", description: "" }, { label: "no", description: "" }];
      await seedMessage(request, {
        sessionKey,
        role: "assistant",
        content: "Prima di continuare:",
        toolCalls: [{
          id: `ask-${Date.now()}`,
          name: "mcp__topics__ask_user_question",
          args: { questions: [{ question, header: "Via", options }] },
          status: "waiting_for_input",
          startedAt: Date.now() - 2_000,
          userInputSchema: { kind: "questions", questions: [{ question, header: "Via", options, multiSelect: false }] },
        }],
      });
      await resetPaneStore(request, [t.id]);
      await page.addInitScript(() => {
        try {
          const raw = window.localStorage.getItem('topics-sidebar-state');
          const prev = raw ? JSON.parse(raw) : {};
          window.localStorage.setItem('topics-sidebar-state', JSON.stringify({ ...prev, viewMode: 'state' }));
        } catch { /* no storage: the assertion below says so */ }
      });
      // The question held by the ask bridge, legged as the Topics tool does
      // until the test ends: that wait is what makes the chat `needs-you`.
      let stopped = false;
      const legs = (async () => {
        while (!stopped) {
          const r = await request.post(`${BASE}/api/sessions/${encodeURIComponent(sessionKey)}/ask-user`, {
            data: { questions: [{ question, header: "Via", options, multiSelect: false }], legMs: 1000 }, timeout: 30_000,
          }).catch(() => null);
          if (!r || !((await r.json().catch(() => ({}))) as { pending?: boolean }).pending) return;
        }
      })();
      await goToApp(page);

      await expect(page.locator('[data-testid="sidebar-state-section-needs-you"]')).toContainText(name, { timeout: 20_000 });
      await expect(page.locator('[data-testid="sidebar-state-section-working"] [data-row-name="chat"]', { hasText: name })).toHaveCount(0);
      stopped = true;
      await legs;
    } finally {
      await deleteTopic(request, t.id).catch(() => {});
    }
  });
});
