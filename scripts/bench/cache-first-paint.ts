#!/usr/bin/env bun
/**
 * scripts/bench/cache-first-paint.ts
 *
 * Misura il tempo tra il click su un topic GIA' VISITATO e il primo messaggio
 * dipinto a schermo, a partire dalla cache localStorage.
 *
 * COSA MISURA
 *   Un topic gia' visitato ha i messaggi in localStorage (messages-cache-*).
 *   Lo script:
 *   1. Crea topic di test via API (/api/topics + /api/test/seed-message)
 *   2. Li semina nella sidebar via API (pane-store-v2) MENTRE il browser e' aperto
 *      (il server notifica il client via WebSocket con ui-state:updated)
 *   3. Visita ogni topic per popolare la cache localStorage
 *   4. Misura: click sul topic -> primo [data-message-id] visibile
 *
 * Il numero "PRIMA" documenta il percorso attuale:
 *   1. getInitialMessages() carica cache al boot (sincrono)
 *   2. loadHistory() parte in useEffect -> loading=true -> fetch HTTP
 *   3. durante la fetch il sipario (SkeletonChatMessages) copre la lista
 *   4. fetch completa -> loading=false -> listSettled -> sipario si alza
 *   Latenza inclusa: LIST_REVEAL_FLOOR_MS (80ms) + latenza HTTP del server
 *
 * COME USARLO
 *   bun scripts/bench/cache-first-paint.ts
 *   E2E_BASE=http://localhost:13781 bun scripts/bench/cache-first-paint.ts
 *   bun scripts/bench/cache-first-paint.ts --samples=7
 *
 * Il server deve avere TOPICS_E2E=1 (per /api/test/seed-message).
 * Il server di test per questo worktree usa la porta derivata dal path.
 * Per trovare la porta attiva: ps aux | grep "TOPICS_E2E=1" | grep BUN_PORT
 *
 * COSA SCRIVE
 *   STDOUT: numero con mediana e range
 *   test-results/cache-first-paint.json: JSON per archiviazione
 *
 * DICHIARATO IN KNIP. Il pattern scripts/bench/*.ts! copre questo file.
 * Non importare da questo script: e' un entry point eseguito a mano.
 */

import { chromium, type Page, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, resolve } from "node:path";

const E2E_BASE = (process.env.E2E_BASE ?? "http://localhost:13781").replace(/\/$/, "");

const SAMPLES_ARG =
  process.argv.find((a) => a.startsWith("--samples="))?.split("=")[1] ??
  process.argv[process.argv.indexOf("--samples") + 1];
const SAMPLES = Number(SAMPLES_ARG ?? 5);
const OUT_PATH = resolve(
  process.env.CACHE_PAINT_OUT?.trim() || "test-results/cache-first-paint.json",
);

const PROBE_TIMEOUT_MS = 12_000;
const CACHE_SETTLE_MS = 1_200;
const MSG_SELECTOR = "[data-message-id]";
const SEED_MESSAGES = 6;

interface Sample {
  ms: number;
  cacheBytes: number;
  topicName: string;
}

interface TopicApi {
  id: string;
  name: string;
  sessionKey: string;
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

async function createTestTopic(request: APIRequestContext, name: string): Promise<TopicApi> {
  const res = await request.post(`${E2E_BASE}/api/topics`, {
    data: { name },
    ignoreHTTPSErrors: true,
  });
  if (!res.ok()) throw new Error(`POST /api/topics ${res.status()}: ${await res.text()}`);
  return (await res.json()) as TopicApi;
}

async function seedMessages(request: APIRequestContext, topic: TopicApi): Promise<void> {
  for (let i = 0; i < SEED_MESSAGES; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const content =
      role === "user"
        ? `Domanda di benchmark ${i + 1}: come funziona la cache?`
        : `Risposta di benchmark ${i + 1}: la cache localStorage tiene i messaggi sotto messages-cache-${topic.sessionKey}.`;
    const r = await request.post(`${E2E_BASE}/api/test/seed-message`, {
      data: { sessionKey: topic.sessionKey, role, content },
      ignoreHTTPSErrors: true,
    });
    if (!r.ok())
      throw new Error(
        `POST /api/test/seed-message ${r.status()}\n` +
          "  Il server deve avere TOPICS_E2E=1.\n" +
          `  Porta corrente: ${E2E_BASE}`,
      );
  }
}

/**
 * Semina il topic nella sidebar MENTRE il browser e' aperto.
 * Il server emette ui-state:updated via WS, il client aggiorna la store
 * e rende visibile il treeitem senza reload.
 * Usa page.request per avere il contesto autenticato del browser.
 */
async function seedTopicVisible(
  request: APIRequestContext,
  topicId: string,
  topicName: string,
): Promise<void> {
  // Legacy panels endpoint.
  try {
    const cur = await request.get(`${E2E_BASE}/api/ui-state/panels`, { ignoreHTTPSErrors: true });
    let openPanels: string[] = [];
    if (cur.ok()) {
      const body = (await cur.json()) as { value?: { openPanels?: string[] }; openPanels?: string[] };
      openPanels = body?.value?.openPanels ?? body?.openPanels ?? [];
    }
    if (!openPanels.includes(topicId)) {
      await request.put(`${E2E_BASE}/api/ui-state/panels`, {
        data: { openPanels: [...openPanels, topicId] },
        ignoreHTTPSErrors: true,
      });
    }
  } catch { /* ignore */ }

  // Phase-30 pane-store-v2.
  // La risposta ha payload_version=2: body.value.value e' il snapshot.
  // In scrittura il server accetta { value: <snapshot> } (il wrapper lo aggiunge).
  try {
    const cur = await request.get(`${E2E_BASE}/api/ui-state/pane-store-v2`, {
      ignoreHTTPSErrors: true,
    });
    type Snapshot = {
      panes: Record<string, unknown>;
      groups: Record<string, { id: string; paneIds: string[]; splitRatio: number; splitAxis: string }>;
      projects?: Record<string, unknown>;
      groupOrder?: string[];
      closedStack?: unknown[];
      lastSeq?: number;
    };
    let snapshot: Snapshot = {
      panes: {},
      groups: {
        "group:default": { id: "group:default", paneIds: [], splitRatio: 1, splitAxis: "horizontal" },
      },
      projects: {},
      groupOrder: ["group:default"],
      closedStack: [],
      lastSeq: 0,
    };
    if (cur.ok()) {
      // payload_version=2: { value: { value: <snapshot>, ... } }
      const body = (await cur.json()) as { value?: { value?: Snapshot } | Snapshot };
      const inner =
        body?.value && typeof body.value === "object" && "value" in body.value
          ? (body.value as { value?: Snapshot }).value
          : (body?.value as Snapshot | undefined);
      if (inner && typeof inner === "object" && "groups" in inner) {
        snapshot = inner;
      }
    }
    if (!snapshot.groups) snapshot.groups = {};
    if (!snapshot.groups["group:default"]) {
      snapshot.groups["group:default"] = {
        id: "group:default",
        paneIds: [],
        splitRatio: 1,
        splitAxis: "horizontal",
      };
    }
    if (!Array.isArray(snapshot.groups["group:default"]!.paneIds)) {
      snapshot.groups["group:default"]!.paneIds = [];
    }
    if (!snapshot.groups["group:default"]!.paneIds.includes(topicId)) {
      snapshot.groups["group:default"]!.paneIds.push(topicId);
    }
    if (!snapshot.panes) snapshot.panes = {};
    snapshot.panes[topicId] = { id: topicId, type: "chat", topicId, title: topicName };
    snapshot.lastSeq = (snapshot.lastSeq ?? 0) + 1;
    await request.put(`${E2E_BASE}/api/ui-state/pane-store-v2`, {
      data: snapshot,
      ignoreHTTPSErrors: true,
    });
  } catch { /* ignore */ }
}

async function cleanupTopics(request: APIRequestContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    await request.delete(`${E2E_BASE}/api/topics/${id}`, { ignoreHTTPSErrors: true }).catch(() => {});
  }
}

/** Apri l'app e aspetta la sidebar. */
async function openApp(page: Page): Promise<void> {
  await page.goto(E2E_BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[aria-label="Topics sidebar"]', {
    timeout: 15_000,
    state: "visible",
  });
  // Aspetta che il WS si connetta e idrati il pane-store.
  await page.waitForTimeout(1_500);
}

/** Aspetta che il topic appaia nella sidebar (dopo seed via WS). */
async function waitForTopicVisible(page: Page, topicName: string): Promise<boolean> {
  try {
    await page.waitForFunction(
      (name: string) => {
        const items = Array.from(document.querySelectorAll("[role=treeitem],[data-topic-id]"));
        return items.some((el) => el.textContent?.includes(name) || el.getAttribute("aria-label")?.includes(name));
      },
      topicName,
      { timeout: 6_000 },
    );
    return true;
  } catch {
    // Tenta con il treeitem standard.
    const item = page.getByRole("treeitem", { name: topicName });
    return item.isVisible({ timeout: 1000 }).catch(() => false);
  }
}

function cacheKey(topic: TopicApi): string {
  return `messages-cache-${topic.sessionKey}`;
}

async function run(): Promise<void> {
  console.log(`[cache-first-paint] server: ${E2E_BASE}  samples: ${SAMPLES}`);

  // Verifica server.
  try {
    const r = await fetch(`${E2E_BASE}/`, { signal: AbortSignal.timeout(4_000) });
    if (!r.ok && r.status !== 404) throw new Error(`status ${r.status}`);
  } catch (e) {
    console.error(`[cache-first-paint] server non raggiungibile: ${e}`);
    console.error(`  Trova la porta: ps aux | grep "TOPICS_E2E=1" | grep BUN_PORT`);
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const request = context.request;
  const samples: Sample[] = [];
  const createdIds: string[] = [];

  try {
    // ── Fase 0: crea topic di test ──────────────────────────────────────────
    const topicCount = SAMPLES + 1;
    console.log(`[cache-first-paint] Creo ${topicCount} topic con ${SEED_MESSAGES} messaggi...`);
    const topics: TopicApi[] = [];
    for (let i = 0; i < topicCount; i++) {
      const t = await createTestTopic(request, `bench-cfp-${Date.now()}-${i}`);
      await seedMessages(request, t);
      topics.push(t);
      createdIds.push(t.id);
      process.stdout.write(".");
    }
    process.stdout.write("\n");

    // ── Fase 1: warm-up — popola cache visitando ogni topic ─────────────────
    console.log(`[cache-first-paint] Fase 1: popola cache...`);
    {
      // Seed tutti i topic nel pane-store PRIMA di aprire il browser.
      // Il browser ricevera' ui-state:init dal WS con la lista aggiornata.
      for (const topic of topics) {
        await seedTopicVisible(request, topic.id, topic.name);
      }

      const warm = await context.newPage();
      await openApp(warm);
      // Aspetta che il client abbia ricevuto ui-state:init e completato le PUT
      // iniziali del proprio snapshot (debounce ~300ms sul syncServer).
      await warm.waitForTimeout(1_000);

      for (const topic of topics) {
        let visible = await waitForTopicVisible(warm, topic.name);
        if (!visible) {
          // Il client potrebbe avere sovritto con il suo LS; re-seed e reload.
          await seedTopicVisible(request, topic.id, topic.name);
          await warm.waitForTimeout(500);
          visible = await waitForTopicVisible(warm, topic.name);
          if (!visible) {
            await warm.reload({ waitUntil: "domcontentloaded" });
            await warm.waitForSelector('[aria-label="Topics sidebar"]', { timeout: 10_000 });
            await warm.waitForTimeout(1_500);
            visible = await waitForTopicVisible(warm, topic.name);
          }
        }

        if (!visible) {
          console.warn(`  "${topic.name}": non visibile, skip warm-up`);
          continue;
        }

        // Clicca il topic e aspetta i messaggi.
        const item = warm.getByRole("treeitem", { name: topic.name });
        await item.click().catch(() => {});
        await warm.waitForSelector(MSG_SELECTOR, { timeout: 10_000, state: "visible" }).catch(() => {
          console.warn(`  "${topic.name}": nessun messaggio nel warm-up`);
        });
        await warm.waitForTimeout(CACHE_SETTLE_MS);
        process.stdout.write(".");
      }
      process.stdout.write("\n");
      await warm.close();
    }

    // ── Fase 2: misura ───────────────────────────────────────────────────────
    console.log(`[cache-first-paint] Fase 2: misura...`);
    const pivot = topics[topics.length - 1]!;

    for (let i = 0; i < SAMPLES; i++) {
      const topic = topics[i]!;
      const page = await context.newPage();
      await openApp(page);

      // Assicura che i topic siano nella sidebar.
      await seedTopicVisible(request, topic.id, topic.name);
      await seedTopicVisible(request, pivot.id, pivot.name);
      await page.waitForTimeout(500);

      // Controlla cache.
      const ck = cacheKey(topic);
      const cacheInfo = await page.evaluate((key: string) => {
        const raw = localStorage.getItem(key);
        return { exists: raw !== null, bytes: raw?.length ?? 0 };
      }, ck);

      if (!cacheInfo.exists || cacheInfo.bytes === 0) {
        console.warn(`  sample ${i} "${topic.name}": cache assente, skip`);
        await page.close();
        continue;
      }

      // Switch al pivot per non avere il target gia' attivo.
      if (pivot.id !== topic.id) {
        const pivotItem = page.getByRole("treeitem", { name: pivot.name });
        if (await pivotItem.isVisible({ timeout: 2000 }).catch(() => false)) {
          await pivotItem.click().catch(() => {});
          await page.waitForTimeout(200);
        }
      }

      // Segna il timestamp del click e aspetta il primo messaggio.
      const targetItem = page.getByRole("treeitem", { name: topic.name });
      if (!(await targetItem.isVisible({ timeout: 3_000 }).catch(() => false))) {
        console.warn(`  sample ${i} "${topic.name}": treeitem non visibile, skip`);
        await page.close();
        continue;
      }

      await page.evaluate(() => {
        performance.mark("click-start");
      });
      await targetItem.click();

      try {
        const handle = await page.waitForFunction(
          () => {
            const el = document.querySelector("[data-message-id]");
            if (!el) return null;
            const marks = performance.getEntriesByName("click-start", "mark");
            if (!marks.length) return null;
            return performance.now() - marks[0]!.startTime;
          },
          null,
          { timeout: PROBE_TIMEOUT_MS },
        );
        const ms = (await handle.jsonValue()) as number;
        console.log(`  sample ${i} "${topic.name}": ${round1(ms)} ms  (cache: ${cacheInfo.bytes} B)`);
        samples.push({ ms, cacheBytes: cacheInfo.bytes, topicName: topic.name });
      } catch (err) {
        console.error(`  sample ${i} FALLITO: ${err}`);
      }

      await page.close();
    }
  } finally {
    await cleanupTopics(request, createdIds);
    await browser.close();
  }

  if (samples.length === 0) {
    console.error("[cache-first-paint] Nessun sample raccolto.");
    process.exit(2);
  }

  const mss = samples.map((s) => s.ms);
  const med = round1(median(mss));
  const min = round1(Math.min(...mss));
  const max = round1(Math.max(...mss));

  console.log("\n========================================");
  console.log("  cache-first-paint: NUMERO PRIMA");
  console.log("========================================");
  console.log(`  Samples:  ${samples.length}`);
  console.log(`  Mediana:  ${med} ms`);
  console.log(`  Min:      ${min} ms`);
  console.log(`  Max:      ${max} ms`);
  console.log(`  Dettagli: ${mss.map((m) => `${round1(m)}ms`).join(", ")}`);
  console.log("========================================");
  console.log(`  RISULTATO: ${med} ms  (click topic -> primo messaggio, con cache)`);
  console.log("========================================\n");

  const payload = {
    $schema: "cache-first-paint-v1",
    measured_at: new Date().toISOString(),
    what: "click su topic gia' visitato -> primo messaggio dipinto (ms), con cache localStorage",
    percorso_attuale: [
      "1. getInitialMessages() carica cache al boot (sincrono)",
      "2. loadHistory() parte in useEffect -> loading=true -> fetch HTTP",
      "3. durante la fetch SkeletonChatMessages copre la lista",
      "4. fetch completa -> loading=false -> listSettled -> sipario si alza",
      "Latenza: LIST_REVEAL_FLOOR_MS (80ms) + latenza HTTP del server",
    ],
    samples: samples.length,
    medianMs: med,
    minMs: min,
    maxMs: max,
    raw: mss.map(round1),
    topics: samples.map((s) => ({
      name: s.topicName,
      cacheBytes: s.cacheBytes,
      ms: round1(s.ms),
    })),
    machine: {
      platform: platform(),
      arch: arch(),
      cpus: cpus().length,
      cpu_model: cpus()[0]?.model ?? "unknown",
      memory_gb: Math.round(totalmem() / 1024 ** 3),
    },
  };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`JSON: ${OUT_PATH}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
