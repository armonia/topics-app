import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { projectPanesKey } from "../../../shared/project-keys";
import { E2E_BASE } from "./test-server";

const BASE = E2E_BASE;

// --- Topic fixtures ---

/**
 * Wait for a topic created via `createTopic` to appear in the mounted UI.
 *
 * Review finding #18: `createTopic` seeds the sidebar by direct state
 * injection into `ui-state/pane-store-v2` and `ui-state/panels` — it
 * bypasses the normal hydration/mount path that React goes through on a
 * fresh page load. That's deliberate (it's the fastest way to set up a
 * pane for a test), but it means a raw `createTopic()` call gives you no
 * evidence that the UI actually rendered the topic. If the hydration path
 * regresses, tests that depend on the sidebar being populated after
 * `createTopic` would pass as false positives (the DB has the row, the
 * injected key has the right shape, but nothing reaches the DOM).
 *
 * Call this helper AFTER `createTopic` (and AFTER `page.goto(...)`) in any
 * test whose assertions depend on the topic being present in the rendered
 * tab bar. Resolves when either:
 *   - a pane tab with the matching `data-pane-id` is visible, OR
 *   - a sidebar row with the matching topic id is visible
 * (the selectors are OR'd so this works against both pane-store-v2 and
 * legacy openPanels-seeded setups).
 */
export async function waitForTopicVisible(
  page: Page,
  topicId: string,
  opts?: { timeout?: number },
): Promise<void> {
  const timeout = opts?.timeout ?? 5000;
  const tabLocator = page.locator(`[data-pane-id="${topicId}"]`).first();
  const sidebarLocator = page.locator(`[data-topic-id="${topicId}"]`).first();
  // `or()` resolves as soon as either locator matches; keeps the helper
  // resilient to layout variants where a topic is only in the sidebar list
  // and the tab hasn't been activated yet, or vice-versa.
  await expect(tabLocator.or(sidebarLocator)).toBeVisible({ timeout });
}

/**
 * Create a topic AND seed it into the sidebar via direct state injection.
 *
 * IMPORTANT (finding #18): state injection BYPASSES the React mount/
 * hydration path — the returned topic exists in the DB and in the
 * persisted ui-state keys, but this function does NOT await UI readiness.
 * If your test asserts on the sidebar/tab-bar AFTER a `page.goto(...)`,
 * call `waitForTopicVisible(page, topic.id)` to prove the injected state
 * actually reached the DOM; otherwise a regression in the hydration path
 * will surface as a false positive (state is there, UI never rendered it).
 */
export async function createTopic(
  request: APIRequestContext,
  name: string,
  opts?: { parentId?: string; systemPrompt?: string; projectPath?: string; color?: string; icon?: string; provider?: string }
): Promise<{ id: string; name: string; slug: string }> {
  const res = await request.post(`${BASE}/api/topics`, {
    data: { name, ...opts },
    ignoreHTTPSErrors: true,
  });
  if (!res.ok()) throw new Error(`Failed to create topic: ${res.status()}`);
  const topic = (await res.json()) as { id: string; name: string; slug: string };

  // Unified timeline sidebar (since commit c9d168e) only shows topics with an
  // open tab or unread messages. UI topic creation (App.tsx handleCreateTopic)
  // auto-opens a tab; raw-API creation must mirror that — otherwise the topic
  // stays invisible in the sidebar even though it exists in the DB.
  //
  // Phase 30 moved pane persistence from /api/ui-state/panels → pane-store-v2
  // (reducer snapshot). Seed both endpoints so tests work against both pre-
  // and post-Phase-30 clients.
  await seedTopicIntoSidebar(request, topic.id).catch(() => {
    // Non-fatal — tests that don't rely on sidebar visibility still work.
  });

  return topic;
}

/** Make a topic visible in the unified timeline sidebar by pre-seeding both
 *  the legacy openPanels endpoint AND the Phase 30 pane-store-v2 snapshot.
 *  Exported so helpers.ts can self-heal baseline topics (e.g. "Web Search Test")
 *  that global-setup creates via raw POST — which does NOT open a tab.
 *
 *  `minSeq` floors the written snapshot's lastSeq. When self-healing AFTER a
 *  client has already loaded, the reload's warm-hydrate replays that client's
 *  localStorage snapshot; the server write only wins the LWW gate if its seq
 *  strictly exceeds the local one. Pass the live client's local lastSeq here so
 *  the seed outranks it. Unused (0) at creation time, when no client is up. */
export async function seedTopicIntoSidebar(request: APIRequestContext, topicId: string, minSeq = 0): Promise<void> {
  // --- Legacy panels endpoint (pre-Phase-30 clients) ---
  try {
    const cur = await request.get(`${BASE}/api/ui-state/panels`, { ignoreHTTPSErrors: true });
    let openPanels: string[] = [];
    if (cur.ok()) {
      const body = (await cur.json()) as { value?: { openPanels?: string[] }; openPanels?: string[] };
      openPanels = body?.value?.openPanels ?? body?.openPanels ?? [];
    }
    if (!openPanels.includes(topicId)) {
      await request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [...openPanels, topicId] },
        ignoreHTTPSErrors: true,
      });
    }
  } catch { /* ignore */ }

  // --- Phase 30 pane-store-v2 reducer snapshot ---
  // Shape (see client/src/state/pane/selectors.ts selectSyncableSnapshot):
  //   { panes, groups, projects, groupOrder, closedStack, lastSeq }
  // App.tsx's openPanels mirrors store.groups['group:default'].paneIds — so
  // injecting the topic there is what makes it appear in the sidebar.
  try {
    await seedPaneStore(request, async () => {
      const cur = await request.get(`${BASE}/api/ui-state/pane-store-v2`, { ignoreHTTPSErrors: true });
      let snapshot: any = {
        panes: {},
        groups: { 'group:default': { id: 'group:default', paneIds: [], splitRatio: 1, splitAxis: 'horizontal' } },
        projects: {},
        groupOrder: ['group:default'],
        closedStack: [],
      };
      if (cur.ok()) {
        const body = (await cur.json()) as { value?: any };
        if (body?.value && typeof body.value === 'object' && 'groups' in body.value) {
          snapshot = body.value;
        }
      }
      if (!snapshot.groups) snapshot.groups = {};
      if (!snapshot.groups['group:default']) {
        snapshot.groups['group:default'] = { id: 'group:default', paneIds: [], splitRatio: 1, splitAxis: 'horizontal' };
      }
      if (!Array.isArray(snapshot.groups['group:default'].paneIds)) {
        snapshot.groups['group:default'].paneIds = [];
      }
      if (!snapshot.groups['group:default'].paneIds.includes(topicId)) {
        snapshot.groups['group:default'].paneIds.push(topicId);
      }
      if (!snapshot.panes) snapshot.panes = {};
      if (!snapshot.panes[topicId]) {
        // `openedAt` is NOT decoration — it is the causal half of the close
        // protocol. The client's hydrate runs a tombstone strip that deletes
        // any pane whose id carries a close marker UNLESS the pane was opened
        // after it (reducers/panes.ts: `openedAt > tombstones[id]`). The real
        // OPEN_PANE stamps it; a seed without it is silently stripped the
        // moment the topic has ever been closed/archived — which is routine,
        // since closing a chat tab archives the topic (2-state model). Stamp
        // it here so this helper stands in for a genuine open.
        snapshot.panes[topicId] = { id: topicId, type: 'chat', title: '', topicId, openedAt: Date.now() };
      } else if (typeof snapshot.panes[topicId].openedAt !== 'number') {
        snapshot.panes[topicId].openedAt = Date.now();
      }
      // The other half of OPEN_PANE's contract (`retractStaleMarker`): a reopen
      // RETRACTS the close claim. Without this the marker outlives the reopen
      // and every subsequent hydrate strips the tab again.
      if (snapshot.tombstones && typeof snapshot.tombstones === 'object') {
        for (const key of Object.keys(snapshot.tombstones)) {
          if (key === topicId || key.endsWith(`:${topicId}`)) delete snapshot.tombstones[key];
        }
      }
      if (Array.isArray(snapshot.closedStack)) {
        snapshot.closedStack = snapshot.closedStack.filter(
          (r: any) => !(r && (r.id === topicId || r.pane?.id === topicId || r.pane?.topicId === topicId)),
        );
      }
      if (!Array.isArray(snapshot.groupOrder)) snapshot.groupOrder = ['group:default'];
      if (!snapshot.groupOrder.includes('group:default')) snapshot.groupOrder.unshift('group:default');
      return snapshot;
    }, minSeq);
  } catch { /* ignore */ }
}

/** Minimal sanitizer-safe Pane record for a pane id, inferring the type the
 *  same way the client's adapters do (chat for bare topic UUIDs). */
/**
 * Una pane seminata senza `openedAt` NON è causalmente nuova: il reducer la
 * data solo al momento dell'hydrate (`pane.openedAt ?? … ?? Date.now()`,
 * reducers/panes.ts:106), quindi qualsiasi tombstone che arrivi DOPO l'hydrate
 * — il flush di teardown dello spec precedente, tipicamente — ha un `closedAt`
 * più recente e la sfratta (regola `openedAt > closedAt`, panes.ts:422).
 *
 * Si vedeva così: split-screen-sync semina [A, B, C] e la board ne mostra due,
 * ["B", "C"] — spariva sempre e solo la topic che lo spec precedente aveva
 * tenuto aperta, cioè l'unica per cui esisteva un tombstone. Timbrando qui
 * l'istante del seed la pane nasce più recente di qualunque chiusura passata,
 * ed è anche la semantica giusta: questa pane è stata aperta ORA.
 */
const seedOpenedAt = () => Date.now();

/** I prefissi che marcano una pane NON di chat (`paneRecordForId` li mappa uno a uno). */
const NON_CHAT_PANE_PREFIXES = ["terminal:", "browser:", "project:"] as const;

/** True se l'id è una topic di chat nuda, cioè un pane id senza prefisso di tipo. */
function isChatTopicPaneId(id: string): boolean {
  if (NON_CHAT_PANE_PREFIXES.some((p) => id.startsWith(p))) return false;
  return !(id.startsWith("__") && id.endsWith("__")); // utility panel
}

function paneRecordForId(id: string): Record<string, unknown> {
  const openedAt = seedOpenedAt();
  if (id.startsWith("terminal:")) {
    return {
      id,
      type: "terminal",
      title: "Terminal",
      terminalSessionId: id.slice("terminal:".length),
      openedAt,
    };
  }
  if (id.startsWith("browser:")) {
    return { id, type: "browser", title: "Browser", openedAt };
  }
  if (id.startsWith("project:")) {
    const path = decodeURIComponent(id.slice("project:".length));
    return { id, type: "project", title: path.split("/").pop() || path, projectPath: path, openedAt };
  }
  if (id.startsWith("__") && id.endsWith("__")) {
    // Utility panel id (`__<type>__`, see UtilityPanel.utilityPanelId).
    return { id, type: id.slice(2, -2), title: "", openedAt };
  }
  return { id, type: "chat", title: "", topicId: id, openedAt };
}

/** How many times `resetPaneStore` re-writes when a late beacon overwrites it. */
const RESET_MAX_ATTEMPTS = 3;
/** Polls for the pane-store to stop moving before we write over it. */
const QUIET_POLLS = 20;
const QUIET_INTERVAL_MS = 50;

/** The pane-store envelope: the snapshot's own `lastSeq` + the server's LWW seq. */
async function readPaneStore(
  request: APIRequestContext,
): Promise<{ lastSeq: number; serverSeq: number }> {
  try {
    const res = await request.get(`${BASE}/api/ui-state/pane-store-v2`, { ignoreHTTPSErrors: true });
    if (!res.ok()) return { lastSeq: 0, serverSeq: 0 };
    const body = (await res.json()) as { value?: { lastSeq?: number }; server_seq?: number };
    return { lastSeq: body?.value?.lastSeq ?? 0, serverSeq: body?.server_seq ?? 0 };
  } catch {
    return { lastSeq: 0, serverSeq: 0 }; // fresh store
  }
}

/**
 * Block until no one else is writing the pane-store.
 *
 * WHY THIS EXISTS — the cumulative-contamination mechanism. When a spec's page
 * closes, `pagehide` fires a FIRE-AND-FORGET `navigator.sendBeacon` PUT of that
 * client's whole snapshot (middleware/syncServer.ts), carrying every tombstone
 * and Spazio it accumulated. That beacon is unordered, so one from the PREVIOUS
 * spec can land AFTER the next spec's reset and silently restore the old state,
 * whose stale tombstones then EVICT the panes this spec just seeded.
 *
 * It explains every property measured: green alone (no previous page), green in
 * pairs (little accumulated state), red only after ~200 tests (enough garbage
 * for the clobber to matter), and failures that MOVE between runs — it is a
 * race, not a broken assertion.
 *
 * STATO — teardown flushes now declare a compare-and-swap base (`?base=<seq>` in
 * `teardownFlushUrl`, honoured by routes/ui-state.ts), so a late beacon from a
 * dying tab is rejected with 409 instead of winning on seq. That closed the
 * clobber described above. This helper stays as defence-in-depth: the DEBOUNCED
 * PUT of a still-live page is deliberately ungated (a 409 there would lose a
 * real user edit), so a page that hasn't finished tearing down can still write
 * under a spec that is already seeding. Don't delete it without re-measuring.
 */
export async function waitForPaneStoreQuiet(
  request: APIRequestContext,
): Promise<{ lastSeq: number; serverSeq: number }> {
  let prev = await readPaneStore(request);
  for (let i = 0; i < QUIET_POLLS; i++) {
    await new Promise((r) => setTimeout(r, QUIET_INTERVAL_MS));
    const cur = await readPaneStore(request);
    if (cur.serverSeq === prev.serverSeq) return cur; // nothing in flight
    prev = cur;
  }
  return prev;
}

/**
 * Write a pane-store snapshot so it actually STICKS: wait for the store to go
 * quiet, write, then check we are still the last writer — and retry if a late
 * beacon landed on top of us.
 *
 * `build()` returns the snapshot minus `lastSeq`, which this helper supplies
 * from the live value so the client's LWW gate accepts the seed (writing a
 * fixed `lastSeq` loses against any accumulated state — see 4868da68). It is
 * re-invoked on every attempt, so a read-modify-write seed re-reads the store
 * it is amending instead of re-applying a stale copy.
 *
 * Any spec that seeds the pane-store by hand must go through here rather than
 * doing a bare PUT, or it inherits the race documented on
 * `waitForPaneStoreQuiet`.
 */
export async function seedPaneStore(
  request: APIRequestContext,
  build: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  minSeq = 0,
): Promise<void> {
  let lastError = "nessun tentativo eseguito";
  for (let attempt = 0; attempt < RESET_MAX_ATTEMPTS; attempt++) {
    const before = await waitForPaneStoreQuiet(request);
    const snapshot = { ...(await build()), lastSeq: Math.max(before.lastSeq, minSeq) + 1 };
    let mySeq = 0;
    try {
      const put = await request.put(`${BASE}/api/ui-state/pane-store-v2`, {
        data: snapshot,
        ignoreHTTPSErrors: true,
      });
      if (put.ok()) {
        mySeq = ((await put.json()) as { server_seq?: number })?.server_seq ?? 0;
        if (mySeq === 0) lastError = "PUT ok ma senza server_seq: seed non confermabile";
      } else {
        lastError = `PUT ${put.status()} ${put.statusText()}`;
      }
    } catch (e) {
      lastError = `PUT fallita: ${e instanceof Error ? e.message : String(e)}`;
    }

    if (mySeq !== 0) {
      // Did our write survive? If a late beacon landed on top, `server_seq`
      // moved past ours and the store is contaminated again — retry.
      const after = await readPaneStore(request);
      if (after.serverSeq === mySeq) return;
      lastError = `un beacon in ritardo ha scavalcato il seed (server_seq ${after.serverSeq} ≠ ${mySeq})`;
    }
  }
  // Prima questa funzione USCIVA COME SUCCESSO da una PUT fallita: `mySeq === 0`
  // era nella stessa condizione di return del caso "scrittura confermata", e
  // l'esaurimento dei tentativi cadeva fuori dal loop senza dire nulla. Un reset
  // che non può fallire è esattamente quello che nessuno vede fallire: il test
  // successivo ripartiva dal workspace lasciato dallo spec precedente, che è la
  // causa per cui i rossi si SPOSTANO tra una run e l'altra invece di stare
  // fermi. Meglio un rosso qui, sulla riga del seed, che un rosso inspiegabile
  // quaranta test più avanti.
  throw new Error(
    `seedPaneStore: pane-store NON riportato a uno stato noto dopo ${RESET_MAX_ATTEMPTS} tentativi — ${lastError}`,
  );
}

/**
 * Reset the AUTHORITATIVE pane channel (pane-store-v2 `group:default`) to
 * EXACTLY `paneIds`, clearing the closedStack.
 *
 * Why: seeding only the legacy `/api/ui-state/panels` endpoint is not enough
 * since Phase 30 — the client hydrates tabs from the pane-store snapshot and
 * UNIONS it with openPanels, so stale panes accumulated in the shared test DB
 * (terminals, project panes from other spec files / previous runs) leak into
 * every "seed N topics" test as extra tabs. Call this alongside the legacy
 * PUTs whenever a test needs a deterministic tab set.
 *
 * Le topic di chat vengono anche RIAPERTE (unarchive) prima del seed. Nel
 * modello dell'app "aperto = tab, chiuso = archiviato" (topic state model): il
 * client filtra le pane di topic archiviate, quindi seminare una pane per una
 * topic archiviata scrive uno stato che la UI è tenuta a ignorare — la pane c'è
 * nello store e la tab non compare. Succedeva davvero, e in modo deterministico:
 * split-screen-sync semina [A, B, C] e la board ne mostra due, ["B", "C"],
 * perché un test precedente dello stesso file aveva CHIUSO la tab A, cioè
 * archiviato la topic. Lo store risultava perfetto (tre pane, tre paneIds nel
 * gruppo, zero tombstones) e la tab restava comunque invisibile: era la topic,
 * non la pane. Chiedere una pane di chat È dichiarare la topic aperta.
 */
export async function resetPaneStore(
  request: APIRequestContext,
  paneIds: string[],
): Promise<void> {
  await Promise.all(
    paneIds.filter(isChatTopicPaneId).map((id) => unarchiveTopic(request, id)),
  );
  await seedPaneStore(request, () => ({
    panes: Object.fromEntries(paneIds.map((id) => [id, paneRecordForId(id)])),
    groups: {
      "group:default": { id: "group:default", paneIds: [...paneIds], splitRatio: 1, splitAxis: "horizontal" },
    },
    projects: {},
    groupOrder: ["group:default"],
    closedStack: [],
    // `tombstones` and `spaces` are deliberately ABSENT, not set to {}. The
    // server PUT replaces the stored value wholesale (`value = excluded.value`,
    // routes/ui-state.ts), so omitting a key already clears it server-side —
    // and writing `{}` would change nothing anyway, because the client hydrate
    // MERGES both fields and never replaces them (`if (clean.spaces)
    // state.spaces = mergeSpaces(...)`, reducers/panes.ts): an empty object
    // iterates zero entries and leaves whatever the client already holds.
    // A previous attempt to "really zero" the reset by adding them was
    // therefore structurally unable to work, and was reverted (14d1a25f).
  }));
}

/**
 * Chiude TUTTI i contesti browser vivi nel test server.
 *
 * I contesti NON stanno in una ui_state: vivono nel processo del server, quindi
 * `resetPaneStore` — che riscrive `pane-store-v2` — non li tocca nemmeno di
 * striscio. Restando vivi vengono ripescati da ogni client che si connette dopo
 * (`useBrowserContexts.ts` → GET /api/browser/status → `buildSidebarItems` +
 * pane montate) e si accumulano per TUTTA la suite seriale: nella run
 * consolidata del 2026-07-27 due contesti aperti al test #69 erano ancora lì al
 * #114, dove facevano esplodere in strict-mode locator di file che col browser
 * non c'entrano nulla (`chat.spec.ts`, 4 tab residue).
 *
 * Chi sporca pulisce: va chiamato in `afterAll` dei file che CREANO contesti,
 * invece di far difendere tutti gli altri.
 */
export async function closeAllBrowserContexts(request: APIRequestContext): Promise<void> {
  const res = await request.get(`${BASE}/api/browser/status`);
  if (!res.ok()) return;
  const body = (await res.json()) as { details?: Array<{ id?: string }> };
  await Promise.all(
    (body.details ?? [])
      .map((c) => c.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((id) =>
        request.delete(`${BASE}/api/browsers/${encodeURIComponent(id)}`).catch(() => {}),
      ),
  );
}

/**
 * Open a PROJECT WINDOW tab for `projectPath` by seeding the `project:<path>`
 * pane into openPanels + pane-store-v2.
 *
 * Why: seeding a project-linked TOPIC id into openPanels no longer surfaces
 * anything — usePanelLifecycle's validation effect purges project-topic ids
 * from openPanels (they belong INSIDE a project window), and the tab-driven
 * sidebar only shows a project row while its pane is open (`hasProjectTab`)
 * or a child has an open tab. Tests that need the project visible in the
 * sidebar must open the project PANE, exactly like the UI does.
 */
export async function seedProjectPane(
  request: APIRequestContext,
  projectPath: string,
): Promise<string> {
  const paneId = `project:${encodeURIComponent(projectPath)}`;
  // Legacy openPanels — append.
  try {
    const cur = await request.get(`${BASE}/api/ui-state/panels`, { ignoreHTTPSErrors: true });
    let openPanels: string[] = [];
    if (cur.ok()) {
      const body = (await cur.json()) as { value?: { openPanels?: string[] }; openPanels?: string[] };
      openPanels = body?.value?.openPanels ?? body?.openPanels ?? [];
    }
    if (!openPanels.includes(paneId)) {
      await request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [...openPanels, paneId] },
        ignoreHTTPSErrors: true,
      });
    }
  } catch { /* ignore */ }
  // Authoritative pane-store — append, THROUGH `seedPaneStore`.
  //
  // Era un PUT NUDO (leggi-modifica-riscrivi senza quiet-wait e senza
  // verificare che la scrittura sopravvivesse), cioe' esattamente cio' che il
  // docstring di `seedPaneStore` vieta. Effetto misurato: un beacon tardivo
  // della pagina del test PRECEDENTE — che sta ancora smontando mentre il
  // beforeEach del successivo semina — atterrava sopra il seed e cancellava il
  // pane del progetto. Il test partiva quindi con un workspace VUOTO, dove
  // l'unico "+" raggiungibile e' quello STANDALONE (che non espone la voce
  // Board): e' la ragione per cui i 7 test di board.spec.ts erano rossi al
  // primo tentativo e verdi solo al retry.
  //
  // `build()` viene ri-eseguito a ogni tentativo, quindi il read-modify-write
  // rilegge lo store che sta emendando invece di riapplicare una copia stantia.
  await seedPaneStore(request, async () => {
    const cur = await request.get(`${BASE}/api/ui-state/pane-store-v2`, { ignoreHTTPSErrors: true });
    let snapshot: any = null;
    if (cur.ok()) {
      const body = (await cur.json()) as { value?: any };
      if (body?.value && typeof body.value === "object" && "groups" in body.value) snapshot = body.value;
    }
    if (!snapshot) {
      snapshot = { panes: {}, groups: {}, projects: {}, groupOrder: ["group:default"], closedStack: [] };
    }
    if (!snapshot.groups["group:default"]) {
      snapshot.groups["group:default"] = { id: "group:default", paneIds: [], splitRatio: 1, splitAxis: "horizontal" };
    }
    if (!snapshot.groups["group:default"].paneIds.includes(paneId)) {
      snapshot.groups["group:default"].paneIds.push(paneId);
    }
    snapshot.panes[paneId] = snapshot.panes[paneId] || paneRecordForId(paneId);
    return snapshot; // `lastSeq` lo fornisce seedPaneStore dal valore live
  });
  return paneId;
}

export async function patchTopic(
  request: APIRequestContext,
  id: string,
  data: Record<string, unknown>
): Promise<void> {
  const res = await request.patch(`${BASE}/api/topics/${id}`, {
    data,
    ignoreHTTPSErrors: true,
  });
  if (!res.ok()) throw new Error(`Failed to patch topic: ${res.status()}`);
}

/**
 * Unarchive (re-open) a topic. The server models archive/unarchive on the
 * `DELETE /api/topics/:id` route with a `{ archived }` body (see topics.ts —
 * DELETE with `archived:false` re-opens; the PATCH route ignores `archived`).
 * This mirrors the client's `topicsApi.archive(id, false)`. Needed because the
 * e2e DB persists across runs, so a baseline topic a prior spec closed stays
 * archived — and archived standalone chats are filtered out of the sidebar.
 */
export async function unarchiveTopic(
  request: APIRequestContext,
  id: string
): Promise<void> {
  await request
    .delete(`${BASE}/api/topics/${id}`, {
      data: { archived: false },
      ignoreHTTPSErrors: true,
    })
    .catch(() => { /* best-effort — waitFor downstream surfaces failure */ });
}

export async function deleteTopic(
  request: APIRequestContext,
  id: string
): Promise<void> {
  // Phase 30.1 polish — destroy the topic's BrowserContext (Playwright
  // server-side Chromium pool, max 20 concurrent) BEFORE deleting the
  // topic record. Each browser-* spec creates contexts via agent/open or
  // navigate; without explicit cleanup, the pool fills up over the suite
  // and subsequent specs fail with "Max contexts reached" 500s.
  // 404 is fine — context might not exist for this topic. Catch to be safe
  // either way (DELETE could 5xx during shutdown).
  await request
    .delete(`${BASE}/api/browsers/${id}`, { ignoreHTTPSErrors: true })
    .catch(() => { /* best-effort */ });
  await request
    .delete(`${BASE}/api/topics/${id}`, {
      ignoreHTTPSErrors: true,
    })
    .catch((err) => console.warn(`[cleanup] deleteTopic ${id}:`, err.message));
  // Also remove this topic's pane IDs from pane-store-v2 + openPanels to keep
  // subsequent test files from seeing orphan references accumulating in the
  // reducer snapshot and the legacy openPanels array.
  await removeTopicFromSidebar(request, id).catch(() => { /* best-effort */ });
}

/** Strip a topic's pane IDs from pane-store-v2 snapshot and from openPanels.
 *  Idempotent; safe to call after the topic has already been deleted. */
async function removeTopicFromSidebar(request: APIRequestContext, topicId: string): Promise<void> {
  // --- Legacy openPanels ---
  try {
    const cur = await request.get(`${BASE}/api/ui-state/panels`, { ignoreHTTPSErrors: true });
    if (cur.ok()) {
      const body = (await cur.json()) as { value?: { openPanels?: string[] }; openPanels?: string[] };
      const openPanels: string[] = body?.value?.openPanels ?? body?.openPanels ?? [];
      if (openPanels.includes(topicId)) {
        await request.put(`${BASE}/api/ui-state/panels`, {
          data: { openPanels: openPanels.filter((x) => x !== topicId) },
          ignoreHTTPSErrors: true,
        });
      }
    }
  } catch { /* ignore */ }

  // --- Phase 30 pane-store-v2 snapshot ---
  // Lo strip passa da `seedPaneStore` come ogni altra scrittura sullo store:
  // un PUT nudo che perde la corsa contro un beacon tardivo lascia il pane
  // orfano dentro lo snapshot — cioe' esattamente la contaminazione che questa
  // funzione esiste per prevenire, e che poi il file successivo paga.
  //
  // Il GET di sondaggio resta: se non c'e' nulla da togliere si esce senza
  // scrivere, cosi' il quiet-wait di seedPaneStore non si paga sul percorso
  // comune (deleteTopic gira a ogni afterAll).
  const stripFrom = (snap: any): boolean => {
    let changed = false;
    if (snap?.panes && snap.panes[topicId]) {
      delete snap.panes[topicId];
      changed = true;
    }
    if (snap?.groups && typeof snap.groups === 'object') {
      for (const g of Object.values(snap.groups) as any[]) {
        if (Array.isArray(g?.paneIds) && g.paneIds.includes(topicId)) {
          g.paneIds = g.paneIds.filter((x: string) => x !== topicId);
          changed = true;
        }
      }
    }
    return changed;
  };

  try {
    const cur = await request.get(`${BASE}/api/ui-state/pane-store-v2`, { ignoreHTTPSErrors: true });
    if (!cur.ok()) return;
    const body = (await cur.json()) as { value?: any };
    const snap = body?.value;
    if (!snap || typeof snap !== 'object') return;
    if (!stripFrom(structuredClone(snap))) return; // niente da togliere

    await seedPaneStore(request, async () => {
      const fresh = await request.get(`${BASE}/api/ui-state/pane-store-v2`, { ignoreHTTPSErrors: true });
      const value = fresh.ok() ? ((await fresh.json()) as { value?: any })?.value : null;
      const target = value && typeof value === 'object' ? value : snap;
      stripFrom(target);
      return target;
    });
  } catch { /* ignore */ }
}

// --- Task fixtures ---

export async function deleteTask(
  request: APIRequestContext,
  projectId: string,
  taskId: string
): Promise<void> {
  await request
    .delete(`${BASE}/api/boards/${projectId}/tasks/${taskId}`, {
      ignoreHTTPSErrors: true,
    })
    .catch((err) =>
      console.warn(`[cleanup] deleteTask ${projectId}/${taskId}:`, err.message)
    );
}

// --- Terminal session fixtures ---

export async function createTerminalSession(
  request: APIRequestContext,
  opts?: { cwd?: string; type?: string; topicId?: string; name?: string; cols?: number; rows?: number }
): Promise<{ id: string; name: string; cwd: string }> {
  const res = await request.post(`${BASE}/api/terminal/sessions`, {
    data: {
      cwd: opts?.cwd || '/tmp',
      type: opts?.type || 'shell',
      topicId: opts?.topicId,
      name: opts?.name,
      cols: opts?.cols || 120,
      rows: opts?.rows || 30,
    },
    ignoreHTTPSErrors: true,
  });
  if (!res.ok()) throw new Error(`Failed to create terminal session: ${res.status()}`);
  return res.json();
}

export async function deleteTerminalSession(
  request: APIRequestContext,
  sessionId: string
): Promise<void> {
  await request.delete(`${BASE}/api/terminal/sessions/${sessionId}`, {
    ignoreHTTPSErrors: true,
  }).catch(() => {});
}

export async function reloadTerminalSession(
  request: APIRequestContext,
  sessionId: string
): Promise<{ status: number; body: any }> {
  const res = await request.post(`${BASE}/api/terminal/sessions/${sessionId}/reload`, {
    ignoreHTTPSErrors: true,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
}

export async function getTerminalSessionBuffer(
  request: APIRequestContext,
  sessionId: string
): Promise<string> {
  const res = await request.get(`${BASE}/api/terminal/sessions/${sessionId}/buffer`, {
    ignoreHTTPSErrors: true,
    // /buffer is now token-gated (it leaks scrollback); the e2e server runs with
    // GATEWAY_TOKEN=test-token (global-setup). NB on a 401 this returns '' — a
    // missing header would surface as a silently-empty buffer, not a hard failure.
    headers: { "x-gateway-token": process.env.GATEWAY_TOKEN ?? "test-token" },
  });
  if (!res.ok()) return "";
  return (await res.json()).buffer ?? "";
}

export async function listTerminalSessions(
  request: APIRequestContext,
  topicId?: string
): Promise<Array<{ id: string; name: string; cwd: string; type: string }>> {
  const url = topicId
    ? `${BASE}/api/terminal/sessions?topicId=${topicId}`
    : `${BASE}/api/terminal/sessions`;
  const res = await request.get(url, { ignoreHTTPSErrors: true });
  if (!res.ok()) return [];
  return res.json();
}

/**
 * Delete every terminal session (active AND dormant) on the test server. Used to
 * get a clean slate: a stale /tmp shell left by a prior run would otherwise be
 * reconnected/revived by the project-terminal open flow and render an empty pane.
 */
export async function deleteAllTerminalSessions(request: APIRequestContext): Promise<void> {
  for (const s of await listTerminalSessions(request)) {
    await deleteTerminalSession(request, s.id);
  }
  try {
    const res = await request.get(`${BASE}/api/terminal/sessions/dormant`, { ignoreHTTPSErrors: true });
    if (res.ok()) {
      for (const s of (await res.json()) as Array<{ id: string }>) {
        await deleteTerminalSession(request, s.id);
      }
    }
  } catch { /* dormant endpoint optional */ }
}

/**
 * Reset the persisted per-project pane layout (`topics-project-panes-<hash>`)
 * for `projectPath` to EMPTY.
 *
 * Why this exists: the e2e test DB persists across runs (DATA_DIR=/tmp/
 * topics-test-data), and the project-panes sync channel is UNION-ADDITIVE on
 * hydrate (projectLayoutSync — the GET hydrate re-adds server panes on every
 * reload). So terminal panes opened by prior runs (or by a prior retry attempt)
 * stay persisted under this key and get union-added back into a fresh page, so
 * a test that opens N terminals sees N + <stale> tabs. Any test asserting an
 * exact terminal-tab count on a shared project (e.g. /tmp) must clear this key
 * first. La chiave arriva da `shared/project-keys.ts`, unica sorgente dell'hash.
 */
export async function resetProjectPanes(
  request: APIRequestContext,
  projectPath: string,
): Promise<void> {
  const key = projectPanesKey(projectPath);
  // Si RILEGGE per verificare che l'azzeramento sia sopravvissuto, come fa
  // `seedPaneStore` per il canale globale. Anche questa chiave e' esposta alla
  // stessa corsa: il client la riscrive con un debounce di 500 ms
  // (projectLayoutSync.SYNC_DEBOUNCE_MS), quindi la pagina del test PRECEDENTE
  // puo' flushare il proprio valore — con dentro i pane ancora aperti —
  // subito DOPO il nostro PUT, e il progetto tornerebbe a idratarsi sporco.
  // Un PUT nudo qui non e' verificabile: fallisce in silenzio e il sintomo
  // compare solo molto piu' avanti nel test.
  //
  // `{ nonChatPanes: [], openChatTopicIds: [] }` e non `{}`: il client SCARTA
  // un valore il cui `nonChatPanes` non e' un array
  // (projectLayoutSync.applyServerValue), quindi `{}` non azzererebbe nulla.
  for (let attempt = 0; attempt < 3; attempt++) {
    await request.put(`${BASE}/api/ui-state/${key}`, {
      data: { nonChatPanes: [], openChatTopicIds: [] },
      ignoreHTTPSErrors: true,
    });
    await new Promise((r) => setTimeout(r, 60));
    const res = await request.get(`${BASE}/api/ui-state/${key}`, { ignoreHTTPSErrors: true });
    if (!res.ok()) return; // chiave mai scritta: non c'e' niente da azzerare
    const value = ((await res.json()) as { value?: { nonChatPanes?: unknown[]; openChatTopicIds?: unknown[] } })?.value;
    const empty =
      (value?.nonChatPanes?.length ?? 0) === 0 && (value?.openChatTopicIds?.length ?? 0) === 0;
    if (empty) return;
  }
  throw new Error(`resetProjectPanes: ${key} non resta vuoto (qualcuno ci riscrive sopra)`);
}

/**
 * Aspetta che un pane APERTO A MANO dentro il progetto sia ARRIVATO al server,
 * cioè che `topics-project-panes-<hash>` lo elenchi in `nonChatPanes`.
 *
 * Serve a chi apre una superficie su una pagina e la vuole ritrovare aperta su
 * un'ALTRA pagina (`helpers/clip.ts`: il prologo monta la board, la scena la
 * ritrova già montata e non la rimonta davanti alla telecamera). Il client
 * scrive quella chiave con un debounce di 500 ms — `projectLayoutSync.SYNC_DEBOUNCE_MS` —
 * quindi chiudere la pagina appena il pane è visibile può arrivare prima della
 * scrittura, e la seconda pagina si idraterebbe senza.
 */
export async function waitForProjectPaneType(
  request: APIRequestContext,
  projectPath: string,
  type: string,
  timeoutMs = 10_000,
): Promise<void> {
  const key = projectPanesKey(projectPath);
  const deadline = Date.now() + timeoutMs;
  let visti: string[] = [];
  while (Date.now() < deadline) {
    const res = await request.get(`${BASE}/api/ui-state/${key}`, { ignoreHTTPSErrors: true });
    if (res.ok()) {
      const value = ((await res.json()) as { value?: { nonChatPanes?: Array<{ type?: string }> } })?.value;
      visti = (value?.nonChatPanes ?? []).map((p) => p?.type ?? "?");
      if (visti.includes(type)) return;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(
    `waitForProjectPaneType: nessun pane «${type}» in ${key} dopo ${timeoutMs} ms (visti: ${visti.join(", ") || "nessuno"})`,
  );
}

/**
 * Seed a project's INNER layout so `topicIds` render as OPEN chat tabs inside the
 * project window. buildSidebarItems only lists a project's child chat when it has
 * an open inner tab (or a notification/pin), and that inner layout is persisted
 * server-side under `topics-project-panes-<hash>` and UNION-hydrated on every
 * reload (projectLayoutSync) — so a fresh Playwright context (which has no
 * localStorage) still picks it up. Needed for cross-window tests that must see a
 * project's child chat in a second window without first opening it there by hand.
 */
export async function seedProjectInnerChats(
  request: APIRequestContext,
  projectPath: string,
  topicIds: string[],
): Promise<void> {
  await request.put(`${BASE}/api/ui-state/${projectPanesKey(projectPath)}`, {
    data: { nonChatPanes: [], openChatTopicIds: [...topicIds] },
    ignoreHTTPSErrors: true,
  });
}

// --- Cleanup helper ---

interface CleanupItems {
  topics?: string[];
  tasks?: Array<{ projectId: string; taskId: string }>;
  terminalSessions?: string[];
}

export async function cleanupAll(
  request: APIRequestContext,
  created: CleanupItems
): Promise<void> {
  const errors: string[] = [];

  for (const id of created.terminalSessions ?? []) {
    await deleteTerminalSession(request, id).catch((err) =>
      errors.push(`terminal ${id}: ${err.message}`)
    );
  }

  for (const id of created.topics ?? []) {
    await deleteTopic(request, id).catch((err) =>
      errors.push(`topic ${id}: ${err.message}`)
    );
  }

  for (const { projectId, taskId } of created.tasks ?? []) {
    await deleteTask(request, projectId, taskId).catch((err) =>
      errors.push(`task ${projectId}/${taskId}: ${err.message}`)
    );
  }

  if (errors.length > 0) {
    console.warn(`[cleanupAll] ${errors.length} cleanup errors:`, errors);
  }
}

/**
 * Holds the dispatcher's periodic reconcile for `ms`.
 *
 * For specs that stage a FAKE agent with `bindTopic`: that shape —
 * `in_progress` with a `working` chip and no live turn — is exactly what
 * reconcile recovers, after two 10s sweeps. Without this brake the spec races a
 * server timer, and losing the race does not look like a race: the card changes
 * column, its DOM node is REPLACED, and whatever gesture was in flight dies
 * with it. It expires on its own, and `POST /api/test/reset` drops it anyway
 * between one spec file and the next.
 */
export async function holdDispatchReconcile(request: APIRequestContext, ms: number): Promise<void> {
  await request.post(`${BASE}/api/test/dispatch-hold`, { data: { ms }, ignoreHTTPSErrors: true });
}
