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

    const fase = (sessionKey: string, phase: string, rev: number) =>
      ws.send({ type: "session:state", sessionKey, state: { phase, rev, claudeSessionId: sessionKey } });

    fase(attende.sessionKey, "awaiting-approval", 1);
    fase(finito.sessionKey, "awaiting-user", 1);
    fase(lavora.sessionKey, "running", 1);

    // `data-attention` è l'appiglio dichiarato dello stato (le classi Tailwind non
    // lo sono: rinominarne una faceva passare i vecchi locator a verde-vuoto).
    const tabAttende = page.locator('[role="tab"][data-attention="input"]');
    const tabFinito = page.locator('[role="tab"][data-attention="done"]');
    await expect(tabAttende.first()).toBeVisible({ timeout: 15000 });
    await expect(tabFinito.first()).toBeVisible({ timeout: 15000 });

    // Lo stato si dice anche a PAROLE — prima non era detto da nessuna parte, e
    // per chi non vede il colore la tab era muta.
    await expect(page.getByRole("tab", { name: /attende una tua risposta/ }).first()).toBeVisible();
    await expect(page.getByRole("tab", { name: /turno finito/ }).first()).toBeVisible();

    // "Al lavoro" NON è un tier: nessun fondo colorato, quindi nessun
    // data-attention. È la distinzione fra i due assi.
    const tabLavora = page.locator(`[role="tab"]`, { hasText: new RegExp(lavora.name) });
    await expect(tabLavora.first()).not.toHaveAttribute("data-attention", /input|done/);
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

    ws.send({ type: "session:state", sessionKey: attende.sessionKey, state: { phase: "awaiting-approval", rev: 1, claudeSessionId: attende.sessionKey } });
    ws.send({ type: "session:state", sessionKey: finito.sessionKey, state: { phase: "awaiting-user", rev: 1, claudeSessionId: finito.sessionKey } });
    await expect(page.locator('[role="tab"][data-attention="input"]').first()).toBeVisible({ timeout: 15000 });

    // Le sezioni: "Attende te" con le due in attesa, e le altre due esistono o no
    // secondo il contenuto (una sezione vuota non si disegna).
    const attesa = page.locator('[data-testid="sidebar-state-section-awaiting"]');
    await expect(attesa).toBeVisible({ timeout: 10000 });
    await expect(attesa).toContainText("Attende te");
    await expect(attesa).toContainText(attende.name);
    await expect(attesa).toContainText(finito.name);

    // La terza topic, senza fase, sta nel resto.
    const resto = page.locator('[data-testid="sidebar-state-section-rest"]');
    await expect(resto).toBeVisible();
    await expect(resto).toContainText(lavora.name);
  });
});
