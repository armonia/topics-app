/**
 * localstorage-write-volume.spec.ts — how many bytes the app pushes into the
 * WebKit localStorage journal, measured on a real session.
 *
 * WHY IT EXISTS. WebKit keeps `localstorage.sqlite3` in WAL mode and does not
 * checkpoint it while the webview session lives, so every `setItem` appends the
 * pages it dirties and the journal only grows: 5.92 GB measured on the machine
 * of whoever uses the app, about 100 MB a day. The cost is therefore the NUMBER
 * OF REWRITES, and the quota (5 MB, respected) says nothing about it.
 *
 * THE METHOD, so the numbers before and after are comparable:
 *  · The counter is installed in an `addInitScript`, hence before any line of
 *    the app: no write can happen before somebody is watching.
 *  · The load is a BURST of topic updates driven from the API. Each one comes
 *    back as a `topic:updated` on the WebSocket, the client applies it and the
 *    topics map changes: this is the exact shape of a working hour, where it is
 *    the agents that move the state, not the hand of whoever is watching.
 *  · The verdict is a COUNT, not a duration: a burst of N updates must cost one
 *    write of `topics-cache`, not N. A count does not change with the load of
 *    the machine, so this can stay on the PR tier.
 *  · The artefact lands in `test-results/storage-writes/<label>.json` so that
 *    BEFORE and AFTER are two files to compare line by line.
 *    Run:  E2E_STORAGE_LABEL=before npx playwright test localstorage-write-volume
 *
 * @covers STORAGE-WAL-01
 */
import { expect, test } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, waitForTopicVisible } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync, writeFileSync } from "node:fs";

hermetic(test);

const BASE = E2E_BASE;
const STAMP = Date.now();

/** How many updates the burst carries. Twelve is a busy minute of the board. */
const BURST = 12;

/**
 * The ceiling the burst must respect.
 *
 * Two and not one: the writer coalesces on a fixed window, so a burst that
 * straddles the edge of the window legitimately lands in two writes. Three
 * would already mean the coalescing is not holding.
 */
const MAX_WRITES_FOR_BURST = 2;

interface WriteCost {
  writes: number;
  bytes: number;
}

type CostTable = Record<string, WriteCost>;

/** Reads the counter installed by the init script. */
async function readCosts(page: import("@playwright/test").Page): Promise<CostTable> {
  return page.evaluate(() => {
    const w = window as unknown as { __storageWrites?: CostTable };
    return w.__storageWrites ?? {};
  });
}

function costOf(table: CostTable, key: string): WriteCost {
  return table[key] ?? { writes: 0, bytes: 0 };
}

test.describe.serial("localStorage write volume", () => {
  const topicIds: string[] = [];

  test.afterAll(async ({ request }) => {
    for (const id of topicIds) await deleteTopic(request, id).catch(() => {});
  });

  test("a burst of topic updates costs one write of topics-cache, not one per update", async ({
    page,
    request,
  }) => {
    // The counter goes in before the app: nothing may be written unobserved.
    await page.addInitScript(() => {
      const table: Record<string, { writes: number; bytes: number }> = {};
      (window as unknown as { __storageWrites: typeof table }).__storageWrites = table;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function patched(this: Storage, key: string, value: string): void {
        if (this === window.localStorage) {
          // One row per WRITER, not per id: `messages-cache-<session>` is one
          // writer, and split per session it hides the very thing we look for.
          const folded = key.startsWith("messages-cache-") ? "messages-cache-*" : key;
          const row = (table[folded] ??= { writes: 0, bytes: 0 });
          row.writes += 1;
          row.bytes += String(value).length;
        }
        original.call(this, key, value);
      };
    });

    const topic = await createTopic(request, `Write volume ${STAMP}`);
    topicIds.push(topic.id);

    await goToApp(page);
    await waitForTopicVisible(page, topic.id);

    // Everything written while booting belongs to the boot, not to the burst.
    const atRest = await readCosts(page);

    // The load: N updates of the same topic, each one a `topic:updated` on the
    // WebSocket that rewrites the topics map on the client.
    let lastName = "";
    for (let i = 0; i < BURST; i++) {
      lastName = `Write volume ${STAMP} r${i}`;
      const res = await request.patch(`${BASE}/api/topics/${topic.id}`, {
        data: { name: lastName },
        ignoreHTTPSErrors: true,
      });
      expect(res.ok()).toBe(true);
    }

    // The condition that closes the burst is not a clock: it is the cache
    // having caught up with the last update. Polling it also swallows the
    // debounce window, without asserting anything about its duration.
    await expect
      .poll(
        async () =>
          page.evaluate(() => window.localStorage.getItem("topics-cache") ?? ""),
        { timeout: 15000 },
      )
      .toContain(lastName);

    const after = await readCosts(page);
    const burstCost: CostTable = {};
    for (const key of new Set([...Object.keys(atRest), ...Object.keys(after)])) {
      const delta = {
        writes: costOf(after, key).writes - costOf(atRest, key).writes,
        bytes: costOf(after, key).bytes - costOf(atRest, key).bytes,
      };
      if (delta.writes > 0) burstCost[key] = delta;
    }

    const label = process.env.E2E_STORAGE_LABEL ?? "current";
    mkdirSync("test-results/storage-writes", { recursive: true });
    writeFileSync(
      `test-results/storage-writes/${label}.json`,
      `${JSON.stringify(
        {
          label,
          at: new Date().toISOString(),
          updatesInBurst: BURST,
          boot: atRest,
          burst: burstCost,
          burstBytes: Object.values(burstCost).reduce((sum, c) => sum + c.bytes, 0),
          burstWrites: Object.values(burstCost).reduce((sum, c) => sum + c.writes, 0),
        },
        null,
        2,
      )}\n`,
    );

    // The verdict: N updates, at most two writes of the big cache.
    expect(costOf(burstCost, "topics-cache").writes).toBeLessThanOrEqual(MAX_WRITES_FOR_BURST);
    // And the cache is not stale: the poll above already proved it carries the
    // last update, so the saving is not paid for with a wrong first frame.
    expect(costOf(burstCost, "topics-cache").writes).toBeGreaterThan(0);
  });
});
