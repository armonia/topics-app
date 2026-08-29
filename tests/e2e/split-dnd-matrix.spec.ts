/**
 * THE CASE TABLE, ROW BY ROW, ASSERTED ON THE TREE.
 *
 * The card asked for a map before a fix: source x destination x expected
 * outcome, written in the spec first (`DNDSPLIT-01`) so that "all the cases"
 * is a list you can count instead of an adjective. This file is that list
 * executed. Every assertion reads the layout TREE -- how many leaves, under
 * which split axis -- and never a screenshot: a split that looks right and
 * builds the wrong tree is the bug that keeps coming back, and a pixel cannot
 * tell them apart.
 *
 * The tree comes out of the DOM through three attributes `SplitTree` publishes:
 * `[data-split-surface]` (the root), `[data-split-node]` (a split, valued with
 * its axis) and `[data-split-leaf]` (a leaf, valued with its identity).
 *
 * The named failure is PRJ-3: inside a project, a window that opens with ONE
 * pane in ONE group painted the edge preview and then swallowed the release.
 * The drop handler refused, on its own initiative, every release whose source
 * group held a single pane -- while the context menu offered the same split and
 * `handleSplitGroup` already knew how to perform it. That divergence is now one
 * predicate, `splitRules.canDropSplit`, asked by both paths.
 *
 * @covers DNDSPLIT-01
 * @covers DNDSPLIT-02
 */
import { mkdirSync } from "fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import {
  resetPaneStore,
  resetProjectPanes,
  seedProjectPane,
  seedProjectInnerChats,
  createTopic,
  deleteTopic,
} from "./helpers/api-fixtures";
import { splitViaContextMenu } from "./helpers/layout";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const PROJECT_PATH = `/tmp/e2e-dndmatrix-${Date.now()}`;

/** djb2-xor -> base36, mirroring `client/src/lib/dndTypes.ts` paneTabScopeType. */
function paneTabScopeType(scope: string): string {
  let h = 5381;
  for (let i = 0; i < scope.length; i++) h = (((h << 5) + h) ^ scope.charCodeAt(i)) >>> 0;
  return `application/x-pane-scope-${h.toString(36)}`;
}

/** A node of the layout tree as the DOM publishes it. */
type TreeNode =
  | { kind: "leaf"; id: string }
  | { kind: "split"; dir: string; children: TreeNode[] };

/**
 * Rebuild the tiling tree of a surface from its DOM.
 *
 * Walks only the nodes that carry the two contract attributes, so the wrappers
 * `SplitTree` puts in between (the flex slot, the divider strip) are invisible
 * here: the shape that comes back is the LOGICAL one the layout model holds,
 * which is the thing a gesture is supposed to change.
 */
async function readTree(page: Page, surfaceIdx = 0): Promise<TreeNode | null> {
  return page.evaluate((idx) => {
    const surfaces = document.querySelectorAll("[data-split-surface]");
    const root = surfaces[idx];
    if (!root) return null;
    type N = { kind: "leaf"; id: string } | { kind: "split"; dir: string; children: N[] };
    const walk = (el: Element): N[] => {
      const out: N[] = [];
      for (const child of Array.from(el.children)) {
        // Another surface starts here (a project window drawn inside a
        // standalone cell). Its tree is ITS tree: read it with its own index,
        // or the two layouts would be spliced into one shape that neither
        // gesture can be asserted against.
        if (child.hasAttribute("data-split-surface")) continue;
        const leaf = child.getAttribute("data-split-leaf");
        const dir = child.getAttribute("data-split-node");
        if (dir !== null) {
          out.push({ kind: "split", dir, children: walk(child) });
          continue;
        }
        if (leaf !== null) {
          // A cell that hosts a vertical sub-stack publishes that stack INSIDE
          // its leaf (CellSubStack). The stack is the finer truth: a top/bottom
          // edge drop splits the column without touching the row above it, and
          // reading only the outer leaf would report "nothing happened".
          const inner = walk(child);
          const nested = inner.length === 1 && inner[0]!.kind === "split" ? inner[0]! : null;
          out.push(nested ?? { kind: "leaf", id: leaf });
          continue;
        }
        out.push(...walk(child));
      }
      return out;
    };
    const top = walk(root);
    return top.length === 1 ? top[0]! : { kind: "split", dir: "row", children: top };
  }, surfaceIdx);
}

/** Every leaf id of a tree, in document order. */
function leaves(node: TreeNode | null): string[] {
  if (!node) return [];
  return node.kind === "leaf" ? [node.id] : node.children.flatMap(leaves);
}

/** A tree as one line, for assertions and for the message when one fails. */
function shape(node: TreeNode | null): string {
  if (!node) return "none";
  return node.kind === "leaf" ? node.id : `${node.dir}(${node.children.map(shape).join(",")})`;
}

/** Every split node of a tree, outermost first. */
function splits(node: TreeNode | null): { dir: string; children: TreeNode[] }[] {
  if (!node || node.kind === "leaf") return [];
  return [{ dir: node.dir, children: node.children }, ...node.children.flatMap(splits)];
}

/** The axis of the outermost split, or null when the surface is a bare leaf. */
function rootAxis(node: TreeNode | null): string | null {
  return node && node.kind === "split" ? node.dir : null;
}

/**
 * Drag a real tab onto a point, with a real payload.
 *
 * Playwright's `dragTo` does not carry a `dataTransfer` the app can read, and
 * `mouse.down/move/up` never starts an HTML5 drag at all. So the gesture is
 * synthesised: the SOURCE gets a genuine `dragstart` (which is what fills the
 * module shelf `dragPayload.ts` the previews read, and what sets the mime types
 * the scope guards test), then the TARGET gets dragenter/dragover/drop with the
 * same `DataTransfer` object -- exactly the sequence a browser produces.
 */
interface DragSourceOpts {
  /** Drag scope to claim, or null for a source that carries no scope (sidebar). */
  scope?: string | null;
  /** Which of the matching elements to grab (default the first). */
  index?: number;
  /** The mime type the source MUST have filled, or null to demand nothing. */
  expect?: string | null;
}

/**
 * PHASE ONE of the gesture: the source gets its `dragstart` and the payload is
 * parked on the page.
 *
 * Split from the drop on purpose. Some drop targets only EXIST while a drag is
 * live (the full-width row strips, the interior row-gap bands mount on the
 * surface's dragenter), so their position cannot be measured inside the same
 * synchronous block that starts the drag: the test has to hand control back to
 * the page, let React commit, and only then aim. Splitting also lets the bar's
 * own `draggedPaneId` state be committed before the first `dragover`, which is
 * what tells a same-group reorder from an insert coming from elsewhere.
 */
async function startDrag(page: Page, selector: string, opts: DragSourceOpts = {}): Promise<void> {
  const scope = opts.scope === undefined ? "main" : opts.scope;
  await page.evaluate(
    ({ selector, index, scopeType, expected }) => {
      const src = document.querySelectorAll(selector)[index];
      if (!src) throw new Error(`no drag source at ${selector}[${index}]`);
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      // A source that did not fill the payload is not draggable -- fail loudly
      // rather than assert on a drag that never carried anything.
      if (expected && !dt.types.includes(expected)) throw new Error(`dragstart carried no ${expected} payload`);
      if (scopeType && !dt.types.includes(scopeType)) dt.setData(scopeType, "1");
      (window as unknown as { __dndMatrix?: { dt: DataTransfer; src: Element } }).__dndMatrix = { dt, src };
    },
    {
      selector,
      index: opts.index ?? 0,
      scopeType: scope === null ? null : paneTabScopeType(scope),
      expected: opts.expect === undefined ? "application/x-pane-tab" : opts.expect,
    },
  );
}

/**
 * PHASE TWO: dragenter + dragover on the element under the point.
 *
 * `preventDefault` on the last dragover IS the answer "yes, you may drop here",
 * so it is also the honest read of whether the target offered the gesture at
 * all. That is the promise the drop has to keep.
 */
async function dragOverPoint(page: Page, target: { x: number; y: number }): Promise<boolean> {
  return page.evaluate((target) => {
    const held = (window as unknown as { __dndMatrix?: { dt: DataTransfer; src: Element } }).__dndMatrix;
    if (!held) throw new Error("no drag in flight");
    const el = document.elementFromPoint(target.x, target.y);
    if (!el) throw new Error("no element at drop point");
    const mk = (type: string) =>
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: held.dt,
        clientX: target.x,
        clientY: target.y,
      });
    el.dispatchEvent(mk("dragenter"));
    const over = mk("dragover");
    el.dispatchEvent(over);
    return over.defaultPrevented;
  }, target);
}

/**
 * PHASE THREE: the release, on whatever is topmost at that point NOW.
 *
 * With a fresh `dragover` first, and the answer comes back: a real pointer keeps
 * asking as long as it hovers, and targets that only exist mid-drag (the
 * full-width strips) can slide UNDER the pointer between one frame and the next.
 * Reading the promise from the LAST dragover before the release is what makes
 * "previewed" and "outcome" the same question asked twice.
 */
async function dropAtPoint(page: Page, target: { x: number; y: number }): Promise<boolean> {
  return page.evaluate((target) => {
    const held = (window as unknown as { __dndMatrix?: { dt: DataTransfer; src: Element } }).__dndMatrix;
    if (!held) throw new Error("no drag in flight");
    const el = document.elementFromPoint(target.x, target.y);
    if (!el) throw new Error("no element at drop point");
    const mk = (type: string) =>
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: held.dt,
        clientX: target.x,
        clientY: target.y,
      });
    const over = mk("dragover");
    el.dispatchEvent(over);
    el.dispatchEvent(mk("drop"));
    return over.defaultPrevented;
  }, target);
}

/**
 * PHASE FOUR: the `dragend` the source always gets, at `at` when the release
 * happened somewhere the app cannot see (row 9 of the table drops the tab
 * outside the window, and the coordinates are the whole signal).
 */
async function endDrag(page: Page, at?: { x: number; y: number }): Promise<void> {
  await page.evaluate((at) => {
    const held = (window as unknown as { __dndMatrix?: { dt: DataTransfer; src: Element } }).__dndMatrix;
    if (!held) return;
    held.src.dispatchEvent(
      new DragEvent("dragend", {
        bubbles: true,
        dataTransfer: held.dt,
        clientX: at ? at.x : 0,
        clientY: at ? at.y : 0,
      }),
    );
    (window as unknown as { __dndMatrix?: unknown }).__dndMatrix = undefined;
  }, at);
}

/**
 * Drag a real tab onto a point, with a real payload: the four phases in one
 * call, for the cases whose target is visible before the drag starts.
 *
 * Playwright's `dragTo` does not carry a `dataTransfer` the app can read, and
 * `mouse.down/move/up` never starts an HTML5 drag at all. So the gesture is
 * synthesised: the SOURCE gets a genuine `dragstart` (which is what fills the
 * module shelf `dragPayload.ts` the previews read, and what sets the mime types
 * the scope guards test), then the TARGET gets dragenter/dragover/drop with the
 * same `DataTransfer` object -- exactly the sequence a browser produces.
 */
async function dragTabTo(
  page: Page,
  tabSelector: string,
  target: { x: number; y: number },
  opts: DragSourceOpts & { dropAtEnd?: boolean } = { scope: "main" },
): Promise<{ previewed: boolean }> {
  await startDrag(page, tabSelector, opts);
  let previewed = await dragOverPoint(page, target);
  if (opts.dropAtEnd !== false) previewed = await dropAtPoint(page, target);
  await endDrag(page, target);
  return { previewed };
}

/** Centre of the project surface's Nth pane body, and its box. */
async function paneBox(page: Page, idx = 0) {
  const box = await page.locator("[data-split-surface] [data-split-leaf]").nth(idx).boundingBox();
  if (!box) throw new Error(`no pane body at index ${idx}`);
  return box;
}

/** The pane ids the tab bars under `scope` list, in document order. */
function tabsIn(page: Page, scope = '[role="main"]'): Promise<string[]> {
  return page
    .locator(`${scope} [data-testid="panel-tab-bar"] [data-pane-id]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-pane-id") ?? ""));
}

/**
 * The grid cell that holds `paneId`, as a selector.
 *
 * Cells are identified by CONTENT, never by index: which side a split puts the
 * new cell on is exactly the kind of thing a test must not assume, and a test
 * that picks "the second cell" reads as a layout assertion while asserting
 * nothing at all.
 */
async function cellOf(page: Page, paneId: string): Promise<string> {
  const cell = await page.evaluate((id) => {
    const tab = document.querySelector(`[data-pane-id="${id}"]`);
    return tab?.closest("[data-panel-cell]")?.getAttribute("data-panel-cell") ?? null;
  }, paneId);
  if (!cell) throw new Error(`no grid cell holds the pane ${paneId}`);
  return `[data-panel-cell="${cell}"]`;
}

/**
 * The tabs of the cell that CURRENTLY holds `paneId`, or [] when no cell does.
 *
 * Re-resolved on every call on purpose: `data-panel-cell` is a POSITION, and a
 * drop can renumber the grid under it. Polling a stale coordinate answers about
 * whatever moved into that slot, which is the kind of green nobody should trust.
 */
async function tabsWithPane(page: Page, paneId: string): Promise<string[]> {
  try {
    return await tabsIn(page, await cellOf(page, paneId));
  } catch {
    return [];
  }
}

/** Bounding box of the first element matching `selector`. */
async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return box;
}

/** The centre of a box: the "merge into this pane" point of the 5-zone model. */
function centre(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Open the app with `ids` seeded as ONE standalone pool cell.
 *
 * `resetPaneStore` alone is not a reset: the standalone grid ALSO persists its
 * splits in `grid-layout` (soloTopicIds and the rows), so a test that splits
 * hands the next one a surface that is already divided. Measured here: the
 * cross-group bar drop passed alone and failed in the file, on a grid the
 * previous case had left split.
 */
async function openStandalone(page: Page, request: APIRequestContext, ids: string[]): Promise<void> {
  await resetPaneStore(request, ids);
  await request
    .put(`${E2E_BASE}/api/ui-state/grid-layout`, { data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] } })
    .catch(() => {});
  await request.put(`${E2E_BASE}/api/ui-state/panels`, { data: { openPanels: ids } }).catch(() => {});
  await goToApp(page);
  await page.locator("[data-split-surface]").first().waitFor({ state: "visible", timeout: 15000 });
  if (ids[0]) await page.locator(`[data-pane-id="${ids[0]}"]`).first().waitFor({ state: "visible", timeout: 15000 });
}

/**
 * Split the pool in two and answer with the selector of the cell that ended up
 * holding `paneId`: the two-cell arrangement half the table needs.
 */
async function splitOff(page: Page, paneId: string, direction: "Dividi a destra" | "Dividi in basso"): Promise<string> {
  const before = leaves(await readTree(page)).length;
  await splitViaContextMenu(page, direction);
  // The count that means "it split" is the standalone surface's LEAVES, not the
  // tab bars on screen: an open project window puts bars of its own out there.
  await expect
    .poll(async () => leaves(await readTree(page)).length, { timeout: 5000, message: "the split must add a cell" })
    .toBe(before + 1);
  return cellOf(page, paneId);
}

test.describe("Drag-and-drop and split: the case table", () => {
  // NOT serial: every case reseeds the surface it needs, and a serial file
  // turns the first red into eleven skips -- which reads like coverage that
  // does not exist. A case that fails here fails alone.

  let topic: { id: string; name: string };
  /** Three tabs in the pool plus one topic that is PINNED and never open. */
  let idA = "";
  let idB = "";
  let idC = "";
  let idPin = "";
  let nameC = "";
  /** A chat that lives INSIDE the project, so its window has something to draw. */
  let idPrj = "";

  test.beforeAll(async ({ request }) => {
    topic = await createTopic(request, `dnd-matrix-${Date.now()}`);
    idA = topic.id;
    idB = (await createTopic(request, `dnd-matrix-b-${Date.now()}`)).id;
    const c = await createTopic(request, `dnd-matrix-c-${Date.now()}`);
    idC = c.id;
    nameC = c.name;
    idPin = (await createTopic(request, `dnd-matrix-pin-${Date.now()}`)).id;
    // The project needs a real directory and a chat of its own, or its window
    // opens on the empty state and draws no tree to assert against.
    mkdirSync(PROJECT_PATH, { recursive: true });
    idPrj = (await createTopic(request, `dnd-matrix-prj-${Date.now()}`, { projectPath: PROJECT_PATH })).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [idA, idB, idC, idPin]) if (id) await deleteTopic(request, id).catch(() => {});
    await resetProjectPanes(request, PROJECT_PATH).catch(() => {});
  });

  /**
   * The pinned tile is the only source that survives an EMPTY grid: pinning is
   * not opening, and a pinned topic with its tab closed is the normal state of
   * a pinned topic. Seeded on both sides (server ui-state and the localStorage
   * the sidebar hydrates from) so the tile is there on first paint.
   */
  async function pin(page: Page, id: string): Promise<void> {
    await page.request
      .put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
        data: { pinnedItems: [id], viewMode: "timeline", showArchived: false },
      })
      .catch(() => {});
    await page.addInitScript((pinned: string) => {
      localStorage.setItem(
        "topics-sidebar-state",
        JSON.stringify({ pinnedItems: [pinned], viewMode: "timeline", showArchived: false }),
      );
    }, id);
  }

  test("TREE-01: the layout tree is readable from the DOM", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    await resetPaneStore(request, [topic.id]);
    await goToApp(page);
    await page.locator("[data-split-surface]").first().waitFor({ state: "visible", timeout: 15000 });

    const tree = await readTree(page);
    expect(tree, "a drawn surface must publish a tree").not.toBeNull();
    expect(leaves(tree).length, "at least one leaf").toBeGreaterThan(0);

    // The axis is not decoration: it is what tells a left/right split from a
    // top/bottom one, and the whole table is written in those terms.
    const axes = await page.locator("[data-split-surface] [data-split-node]").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-split-node")),
    );
    for (const a of axes) expect(["row", "col"]).toContain(a);
  });

  test("PRJ-3: inside a project, ONE pane splits onto its own edge", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-02" });
    await resetPaneStore(request, [topic.id]);
    await resetProjectPanes(request, PROJECT_PATH).catch(() => {});
    await seedProjectPane(request, PROJECT_PATH);
    await goToApp(page);

    const surface = page.locator("[data-split-surface]").last();
    await surface.waitFor({ state: "visible", timeout: 15000 });
    await page.locator('[data-testid="panel-tab-bar"]').last().waitFor({ state: "visible", timeout: 15000 });

    const before = leaves(await readTree(page, (await page.locator("[data-split-surface]").count()) - 1));

    const box = await paneBox(page, 0);
    const tab = '[data-testid="panel-tab-bar"] [draggable="true"]';
    await page.locator(tab).first().waitFor({ state: "visible", timeout: 15000 });

    // The RIGHT edge band of the pane body: the relative 5-zone model puts the
    // right split target in the last ~20% of the width.
    const res = await dragTabTo(page, tab, { x: box.x + box.width * 0.92, y: box.y + box.height * 0.5 }, {
      scope: PROJECT_PATH,
    });

    // The promise and the outcome, asserted together -- that pairing IS the
    // requirement. A target that lit up and changed nothing is the failure the
    // card reported, and it stays red until it is not true any more.
    expect(res.previewed, "the edge band must accept the drop it previews").toBe(true);
    await expect
      .poll(async () => leaves(await readTree(page, (await page.locator("[data-split-surface]").count()) - 1)).length, {
        timeout: 5000,
        message: "an edge drop the target accepted must add a leaf",
      })
      .toBeGreaterThan(before.length);
  });

  test("STD-1: a tab dropped elsewhere in its OWN bar only reorders", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    await openStandalone(page, request, [idA, idB, idC]);

    const before = await readTree(page);
    expect(await tabsIn(page), "the pool starts in seeding order").toEqual([idA, idB, idC]);

    // The RIGHT half of the last tab means "insert after it": the bar reads the
    // half, not the tab.
    const last = await boxOf(page, `[data-pane-id="${idC}"]`);
    const res = await dragTabTo(page, `[data-pane-id="${idA}"]`, {
      x: last.x + last.width * 0.8,
      y: last.y + last.height / 2,
    });

    expect(res.previewed, "a bar accepts a tab of its own group").toBe(true);
    await expect
      .poll(() => tabsIn(page), { timeout: 5000, message: "the tab must land after the one it was dropped on" })
      .toEqual([idB, idC, idA]);
    // The whole point of row 1: the ORDER changed inside the leaf, the tree did
    // not. A reorder that grows a leaf is a split nobody asked for.
    expect(shape(await readTree(page)), "no leaf appears, none disappears").toBe(shape(before));
  });

  test("STD-2: a tab dropped on ANOTHER pane's bar changes group, not tree", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    await openStandalone(page, request, [idA, idB, idC]);
    const cellA = await splitOff(page, idA, "Dividi a destra");
    const before = await readTree(page);

    // The right half of the target bar's last tab: "enter at the pointed
    // index", which is what row 2 asks for. Aiming at the bar's empty area
    // instead would be aiming at a point the cell underneath also claims.
    const tabA = await boxOf(page, `${cellA} [data-pane-id="${idA}"]`);
    const res = await dragTabTo(page, `[data-pane-id="${idB}"]`, {
      x: tabA.x + tabA.width * 0.8,
      y: tabA.y + tabA.height / 2,
    });

    expect(res.previewed, "a foreign tab bar of the SAME surface accepts the drop").toBe(true);
    await expect
      .poll(() => tabsWithPane(page, idA), { timeout: 5000, message: "the tab must enter the bar it was dropped on" })
      .toEqual([idA, idB]);
    expect(shape(await readTree(page)), "moving a tab between panes creates no leaf").toBe(shape(before));
  });

  test("STD-4: the bottom edge band stacks under the pointed COLUMN only", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    await openStandalone(page, request, [idA, idB, idC]);
    const cellA = await splitOff(page, idA, "Dividi a destra");
    const before = await readTree(page);
    const rowBefore = splits(before).find((s) => s.dir === "row");
    expect(rowBefore, `a right split publishes a row node: ${shape(before)}`).toBeTruthy();
    expect(splits(before).filter((s) => s.dir === "col" && s.children.length > 1), "no column is stacked yet").toEqual([]);

    const box = await boxOf(page, cellA);
    const res = await dragTabTo(page, `[data-pane-id="${idC}"]`, {
      x: box.x + box.width / 2,
      y: box.y + box.height * 0.92,
    });

    expect(res.previewed, "the bottom band must accept the drop it previews").toBe(true);
    await expect
      .poll(async () => leaves(await readTree(page)).length, {
        timeout: 5000,
        message: "a bottom edge drop the target accepted must add a leaf",
      })
      .toBe(leaves(before).length + 1);

    // Row 4 of the spec table reads "sopra/sotto la SOLA colonna puntata" allow-italian: verbatim quote of the spec row.
    // Read: the row keeps its arity, ONE of its columns became a col split of
    // two, and the other is still a bare leaf.
    const after = await readTree(page);
    const rowAfter = splits(after).find((s) => s.dir === "row");
    expect(rowAfter?.children.length, `no column was added: ${shape(after)}`).toBe(rowBefore!.children.length);
    const stacked = splits(after).filter((s) => s.dir === "col" && s.children.length === 2);
    expect(stacked.length, `exactly one column stacked: ${shape(after)}`).toBe(1);
    expect(
      rowAfter!.children.filter((c) => c.kind === "leaf").length,
      `the other column is untouched: ${shape(after)}`,
    ).toBe(rowBefore!.children.length - 1);
    expect(leaves(after).some((l) => l.includes(idC)), `the new leaf is the dragged tab: ${shape(after)}`).toBe(true);
    expect(await tabsWithPane(page, idC), "and it lives in the column that was pointed at").toContain(idA);
  });

  test("STD-5: the centre of a pane body merges, it does not split", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    await openStandalone(page, request, [idA, idB, idC]);
    const cellA = await splitOff(page, idA, "Dividi a destra");
    const before = await readTree(page);

    const res = await dragTabTo(page, `[data-pane-id="${idB}"]`, centre(await boxOf(page, cellA)));

    expect(res.previewed, "the centre must accept the merge it previews").toBe(true);
    await expect
      .poll(() => tabsWithPane(page, idA), { timeout: 5000, message: "the tab must join the group it was dropped into" })
      .toEqual([idA, idB]);
    expect(shape(await readTree(page)), "a merge creates no leaf").toBe(shape(before));
  });

  test("STD-6: the band between two rows inserts a leaf BETWEEN them", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    await openStandalone(page, request, [idA, idB, idC, idPin]);
    await splitOff(page, idA, "Dividi a destra");

    // A real second ROW first. "Dividi in basso" stacks inside ONE column (that
    // is row 4 of the table), so the gesture that makes a row spanning every
    // column is the full-width strip at the container's bottom edge. Here it is
    // setup, not the subject: without two rows there is no boundary to aim at.
    await startDrag(page, `[data-pane-id="${idC}"]`);
    await dragOverPoint(page, centre(await boxOf(page, await cellOf(page, idB))));
    await page.locator('[data-full-row-zone="bottom"]').waitFor({ state: "attached", timeout: 5000 });
    const strip = centre(await boxOf(page, '[data-full-row-zone="bottom"]'));
    expect(await dragOverPoint(page, strip), "the full-width strip offers the row it draws").toBe(true);
    await dropAtPoint(page, strip);
    await endDrag(page, strip);
    await expect
      .poll(async () => splits(await readTree(page)).find((s) => s.dir === "col")?.children.length ?? 0, {
        timeout: 5000,
        message: "the setup needs the surface split in two rows",
      })
      .toBe(2);

    const before = await readTree(page);
    const rowsBefore = splits(before).find((s) => s.dir === "col")!;

    // The band exists only DURING a drag, so it cannot be aimed at before the
    // gesture starts: begin the drag, let the surface arm itself, then measure.
    // (The SplitTree divider itself is deliberately drop-inert: its grab band is
    // neutralised mid-drag so edge drops reach the cells underneath.)
    await startDrag(page, `[data-pane-id="${idPin}"]`);
    await dragOverPoint(page, centre(await boxOf(page, await cellOf(page, idB))));
    await page.locator("[data-row-gap-zone]").first().waitFor({ state: "attached", timeout: 5000 });
    const gap = centre(await boxOf(page, "[data-row-gap-zone]"));
    const previewed = await dragOverPoint(page, gap);
    await dropAtPoint(page, gap);
    await endDrag(page, gap);

    expect(previewed, "the row boundary must accept the drop it previews").toBe(true);
    await expect
      .poll(async () => splits(await readTree(page)).find((s) => s.dir === "col")?.children.length ?? 0, {
        timeout: 5000,
        message: "the new leaf lands on the axis of the divider it was dropped on",
      })
      .toBe(rowsBefore.children.length + 1);
    expect(leaves(await readTree(page)).length, "and it is a new leaf, not a moved wall").toBe(
      leaves(before).length + 1,
    );
  });

  test("STD-8: on an EMPTY grid the drop opens the topic and loses nothing", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    // Nothing open: the grid is its empty state, which is the only shape in
    // which "empty area of the grid" exists at all (cells fill the surface).
    // With no tab bar on screen the only live drag source is the pinned tile.
    await pin(page, idPin);
    await resetPaneStore(request, []);
    await goToApp(page);
    const tile = page.locator(`[data-pinned-tile="${idPin}"]`).first();
    await tile.waitFor({ state: "visible", timeout: 15000 });
    expect(await page.locator("[data-split-surface]").count(), "no surface while nothing is open").toBe(0);

    const empty = await boxOf(page, '[role="main"]');
    const res = await dragTabTo(page, `[data-pinned-tile="${idPin}"]`, centre(empty), {
      scope: null,
      expect: "application/x-panel-id",
    });

    expect(res.previewed, "the empty grid must accept what it invites").toBe(true);
    await expect
      .poll(async () => leaves(await readTree(page)), { timeout: 8000, message: "the topic must open in the grid" })
      .toHaveLength(1);
    expect(await tabsIn(page), "and it is the dragged topic").toEqual([idPin]);
  });

  test("STD-9: a release OUTSIDE the window leaves the surface coherent", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    await openStandalone(page, request, [idA, idB, idC]);
    const cellA = await splitOff(page, idA, "Dividi a destra");
    const before = await readTree(page);
    const tabsBefore = await tabsIn(page);

    // No drop at all: the release happens where the app has no target, at
    // negative coordinates. The other half of row 9 (the pane detaches into its
    // own window) is native-only -- `handleDragEnd` gates it behind
    // `isNativeApp` -- so from a browser the assertable half is the invariant:
    // nothing is lost, and no leaf is left empty.
    await startDrag(page, `[data-pane-id="${idC}"]`);
    await endDrag(page, { x: -40, y: -40 });

    expect(shape(await readTree(page)), "a drag that landed nowhere changes no tree").toBe(shape(before));
    expect(await tabsIn(page), "and no tab is lost on the way out").toEqual(tabsBefore);
    for (const cell of [cellA, await cellOf(page, idB)]) {
      expect((await tabsIn(page, cell)).length, `${cell} kept at least one tab`).toBeGreaterThan(0);
    }
  });

  test("STD-10: a project tab is REFUSED by the other surface's split targets", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    // A project window only DRAWS a surface when it has something in it: the
    // seeded project pane is a tab of the standalone bar, and an empty project
    // renders its empty state, which publishes no tree. So the project gets a
    // chat of its own and the tab is activated.
    await resetProjectPanes(request, PROJECT_PATH).catch(() => {});
    await resetPaneStore(request, [idA, idB]);
    await request
      .put(`${E2E_BASE}/api/ui-state/grid-layout`, { data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] } })
      .catch(() => {});
    await seedProjectPane(request, PROJECT_PATH);
    await seedProjectInnerChats(request, PROJECT_PATH, [idPrj]);
    await goToApp(page);
    await page.locator('[data-pane-id^="project:"]').first().click();
    await expect
      .poll(() => page.locator("[data-split-surface]").count(), { timeout: 20000, message: "both surfaces drawn" })
      .toBeGreaterThan(1);
    await splitOff(page, idA, "Dividi a destra");

    const surfaces = await page.locator("[data-split-surface]").count();
    const standaloneBefore = await readTree(page, 0);
    const projectBefore = await readTree(page, surfaces - 1);

    // WHAT THIS ROW IS ABOUT, and what it is not. The STRUCTURAL targets of the
    // other surface refuse a foreign tab: the cell dragover drops any tab whose
    // scope is not this grid's, so its edge band paints nothing, the insert
    // dividers ignore foreign tabs, and the full-width strips never mount for
    // one. That is asserted here, on the edge band of a standalone cell, which
    // is exactly the target row 3 splits on for a tab of its own surface.
    //
    // One target on that surface does NOT refuse it, deliberately: the BODY of
    // a standalone group accepts any PANEL_ID+PANE_TAB drag
    // (`StandaloneChatGroup.handleStandaloneDragOver`), which is the "pull a
    // chat out of the project into the workspace" gesture. Preview and outcome
    // agree there -- the law of the table holds -- but the word "qualunque" in
    // row 10 does not, so the release is NOT performed here and the divergence
    // is reported rather than silently encoded as either behaviour.
    const cellBox = await boxOf(page, await cellOf(page, idA));
    const edge = { x: cellBox.x + cellBox.width * 0.92, y: cellBox.y + cellBox.height * 0.5 };
    // The source is the project's OWN chat tab, picked by identity. Picking "the
    // last tab bar" instead is how this test first lied to itself: the tab it
    // grabbed was a standalone one, the standalone scope came along with it, and
    // the surface quite correctly lit up for a tab that was its own.
    const inProject = await page.evaluate((id) => {
      const tab = document.querySelector(`[data-pane-id*="${id}"]`);
      const surface = tab?.closest("[data-split-surface]");
      return !!surface && surface !== document.querySelector("[data-split-surface]");
    }, idPrj);
    expect(inProject, "the dragged tab must belong to the project window, not to the grid").toBe(true);
    await startDrag(page, `[data-pane-id*="${idPrj}"]`, { scope: PROJECT_PATH });
    await dragOverPoint(page, edge);

    // Counted on THIS surface only: the project window, dragging a tab of its
    // own, quite rightly lights up its own strips, and it is drawn inside a
    // cell of the standalone grid.
    const splitAffordances = await page.evaluate(() => {
      const root = document.querySelector("[data-split-surface]");
      if (!root) return -1;
      const sel = "[data-grid-split-overlay], [data-full-row-zone], [data-row-gap-zone]";
      return Array.from(root.querySelectorAll(sel)).filter((el) => el.closest("[data-split-surface]") === root).length;
    });
    expect(splitAffordances, "no split target of another surface lights up for a foreign tab").toBe(0);
    await endDrag(page, edge);

    expect(shape(await readTree(page, 0)), "the standalone surface is untouched").toBe(shape(standaloneBefore));
    expect(shape(await readTree(page, surfaces - 1)), "and so is the project's").toBe(shape(projectBefore));
  });

  test("STD-11: a SIDEBAR row dropped on a pane body joins that leaf", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    await openStandalone(page, request, [idA, idB, idC]);
    const cellA = await splitOff(page, idA, "Dividi a destra");
    const before = await readTree(page);

    // The sidebar row is identified by what a person reads on it, since that is
    // all the row publishes: `role=treeitem` plus its topic name.
    const res = await dragTabTo(page, `[role="treeitem"][aria-label="${nameC}"]`, centre(await boxOf(page, cellA)), {
      scope: null,
      expect: "application/x-panel-id",
    });

    expect(res.previewed, "the pane body must accept what it invites").toBe(true);
    await expect
      .poll(() => tabsWithPane(page, idA), { timeout: 8000, message: "the topic must open in the pane it was dropped on" })
      .toEqual([idA, idC]);
    expect(shape(await readTree(page)), "opening from the sidebar creates no leaf").toBe(shape(before));
  });

  test("STD-12: a PINNED tile dropped on the grid behaves like the sidebar row", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    await pin(page, idPin);
    await openStandalone(page, request, [idA, idB, idC]);
    const cellA = await splitOff(page, idA, "Dividi a destra");
    const before = await readTree(page);
    await page.locator(`[data-pinned-tile="${idPin}"]`).first().waitFor({ state: "visible", timeout: 10000 });

    const res = await dragTabTo(page, `[data-pinned-tile="${idPin}"]`, centre(await boxOf(page, cellA)), {
      scope: null,
      expect: "application/x-panel-id",
    });

    expect(res.previewed, "the pane body must accept what it invites").toBe(true);
    await expect
      .poll(() => tabsWithPane(page, idA), { timeout: 8000, message: "a pinned topic opens where it was dropped" })
      .toEqual([idA, idPin]);
    expect(shape(await readTree(page)), "row 12 is row 11: no leaf either").toBe(shape(before));
  });
});
