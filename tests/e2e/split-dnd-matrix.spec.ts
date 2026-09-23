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
 * @covers DNDSPLIT-04
 * @covers DNDSPLIT-05
 * @covers DNDSPLIT-06
 * @covers DNDSPLIT-07
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
import { canonicalTmpDir } from "./helpers/file-project";

hermetic(test);
// The card asks for a clip of the D15 gestures, so this file films even when
// the run is not an evidence run. File level because Playwright refuses a
// video option inside a describe: it would force a worker of its own.
test.use({ video: "on" });

const PROJECT_PATH = canonicalTmpDir("e2e-dndmatrix");

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

/** The center of a box: the "merge into this pane" point of the 5-zone model. */
function center(box: { x: number; y: number; width: number; height: number }) {
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
  let projectId = "";
  /**
   * Two MORE chats of the project. They cannot be `idB`/`idC`: a project window
   * draws the chats whose topic belongs to THAT project, so a pool topic seeded
   * into `openChatTopicIds` never materialises a pane and the drag finds no
   * source. Measured on WebKit, where every project row failed with exactly
   * that message before these existed.
   */
  let projectB = "";
  let projectC = "";

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
    projectId = (await createTopic(request, `dnd-matrix-prj-${Date.now()}`, { projectPath: PROJECT_PATH })).id;
    projectB = (await createTopic(request, `dnd-matrix-prj-b-${Date.now()}`, { projectPath: PROJECT_PATH })).id;
    projectC = (await createTopic(request, `dnd-matrix-prj-c-${Date.now()}`, { projectPath: PROJECT_PATH })).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of [idA, idB, idC, idPin, projectB, projectC]) if (id) await deleteTopic(request, id).catch(() => {});
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

  test("STD-5: the center of a pane body merges, it does not split", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-01" });
    await openStandalone(page, request, [idA, idB, idC]);
    const cellA = await splitOff(page, idA, "Dividi a destra");
    const before = await readTree(page);

    const res = await dragTabTo(page, `[data-pane-id="${idB}"]`, center(await boxOf(page, cellA)));

    expect(res.previewed, "the center must accept the merge it previews").toBe(true);
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
    await dragOverPoint(page, center(await boxOf(page, await cellOf(page, idB))));
    await page.locator('[data-full-row-zone="bottom"]').waitFor({ state: "attached", timeout: 5000 });
    const strip = center(await boxOf(page, '[data-full-row-zone="bottom"]'));
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
    await dragOverPoint(page, center(await boxOf(page, await cellOf(page, idB))));
    await page.locator("[data-row-gap-zone]").first().waitFor({ state: "attached", timeout: 5000 });
    const gap = center(await boxOf(page, "[data-row-gap-zone]"));
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
    const res = await dragTabTo(page, `[data-pinned-tile="${idPin}"]`, center(empty), {
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
    await seedProjectInnerChats(request, PROJECT_PATH, [projectId]);
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
    }, projectId);
    expect(inProject, "the dragged tab must belong to the project window, not to the grid").toBe(true);
    await startDrag(page, `[data-pane-id*="${projectId}"]`, { scope: PROJECT_PATH });
    await dragOverPoint(page, edge);

    // Counted on THIS surface only: the project window, dragging a tab of its
    // own, quite rightly lights up its own strips, and it is drawn inside a
    // cell of the standalone grid.
    const splitAffordances = await page.evaluate(() => {
      const root = document.querySelector("[data-split-surface]");
      if (!root) return -1;
      const selector = "[data-grid-split-overlay], [data-full-row-zone], [data-row-gap-zone]";
      return Array.from(root.querySelectorAll(selector)).filter((el) => el.closest("[data-split-surface]") === root).length;
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
    const res = await dragTabTo(page, `[role="treeitem"][aria-label="${nameC}"]`, center(await boxOf(page, cellA)), {
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

    const res = await dragTabTo(page, `[data-pinned-tile="${idPin}"]`, center(await boxOf(page, cellA)), {
      scope: null,
      expect: "application/x-panel-id",
    });

    expect(res.previewed, "the pane body must accept what it invites").toBe(true);
    await expect
      .poll(() => tabsWithPane(page, idA), { timeout: 8000, message: "a pinned topic opens where it was dropped" })
      .toEqual([idA, idPin]);
    expect(shape(await readTree(page)), "row 12 is row 11: no leaf either").toBe(shape(before));
  });

  /* ------------------------------------------------------------------ *
   *  THE SECOND LEVEL, AND THE THREE INVARIANTS AROUND IT.
   *
   *  Everything above points a FIRST-level pane. The rows below point the
   *  place the model is actually thin: a column that is already split
   *  vertically, where one axis is representable and the other is not. Same
   *  law, read twice -- what the dragover promised is what the drop built.
   * ------------------------------------------------------------------ */

  /** The tree with leaf identities erased: the SHAPE a reload has to bring back. */
  function skeleton(node: TreeNode | null): string {
    if (!node) return "none";
    return node.kind === "leaf" ? "leaf" : `${node.dir}(${node.children.map(skeleton).join(",")})`;
  }

  /** The layout leaf that currently holds a pane, by identity and never by index. */
  async function leafOfPane(page: Page, paneFrag: string): Promise<string> {
    const id = await page.evaluate((frag) => {
      const tab = document.querySelector(`[data-pane-id*="${frag}"]`);
      return tab?.closest("[data-split-leaf]")?.getAttribute("data-split-leaf") ?? null;
    }, paneFrag);
    if (!id) throw new Error(`no layout leaf holds a pane matching ${paneFrag}`);
    return id;
  }

  /**
   * The BODY box of the leaf that holds `paneFrag`: the cell MINUS its tab bar.
   *
   * That subtraction is the whole point. In a project the drop handlers sit on
   * the content div, so the zone classifier works on a rect that starts under
   * the bar; aiming at a fraction of the CELL would put a "top edge" point on
   * the bar, where a different handler owns the gesture. The bar is measured,
   * never assumed to be some number of pixels tall.
   */
  async function paneBodyBox(page: Page, paneFrag: string) {
    const leaf = await leafOfPane(page, paneFrag);
    const cell = await boxOf(page, `[data-split-leaf="${leaf}"]`);
    const bar = await boxOf(page, `[data-split-leaf="${leaf}"] [data-testid="panel-tab-bar"]`);
    const top = bar.y + bar.height;
    return { x: cell.x, y: top, width: cell.width, height: cell.height - (top - cell.y) };
  }

  /**
   * A point in the edge band of `body`, a fixed inset in from the named side.
   *
   * A FIXED inset and not a fraction, deliberately: the ring classifies by
   * nearest edge, so on a short wide slot a point at 8% of the width is still
   * further from the right edge than from the top one, and the gesture under
   * test would silently become a different gesture. 10px is inside every band
   * the classifier can produce -- its floor is 30px.
   */
  function edgePoint(
    body: { x: number; y: number; width: number; height: number },
    edge: "left" | "right" | "top" | "bottom",
  ) {
    const INSET = 10;
    if (edge === "left") return { x: body.x + INSET, y: body.y + body.height / 2 };
    if (edge === "right") return { x: body.x + body.width - INSET, y: body.y + body.height / 2 };
    if (edge === "top") return { x: body.x + body.width / 2, y: body.y + INSET };
    return { x: body.x + body.width / 2, y: body.y + body.height - INSET };
  }

  /**
   * Open a project window with `chatIds` as chats of its own, on a standalone
   * grid that holds nothing but the project tab -- so the only tree worth
   * asserting is the project's, and it is the LAST surface.
   */
  async function openProject(page: Page, request: APIRequestContext, chatIds: string[]): Promise<number> {
    await resetProjectPanes(request, PROJECT_PATH).catch(() => {});
    await resetPaneStore(request, []);
    await request
      .put(`${E2E_BASE}/api/ui-state/grid-layout`, { data: { gridRows: [], gridRowHeights: [], soloTopicIds: [] } })
      .catch(() => {});
    await seedProjectPane(request, PROJECT_PATH);
    await seedProjectInnerChats(request, PROJECT_PATH, chatIds);
    // The project's GEOMETRY (rows, columns, stacks) is device-local: it lives
    // in localStorage, not in the ui-state the reset above clears. Without this
    // the second case of a table-driven row opens on the split the first one
    // built, and its precondition fails on a surface that is not dirty so much
    // as remembered. Measured on WebKit: case 1 green, case 2 red every time.
    //
    // ARMED, not unconditional. An init script runs on EVERY navigation, this
    // page's own `page.reload()` included -- and PRJ-8 reloads on purpose to
    // check the arrangement comes BACK. An unconditional clear wiped exactly
    // what that row measures, and the failure read like a product one. The flag
    // is set here, consumed by the first load after it, and gone by the reload.
    await page.evaluate(() => sessionStorage.setItem("topics-e2e-clear-project-layout", "1")).catch(() => {});
    await page.addInitScript(() => {
      if (sessionStorage.getItem("topics-e2e-clear-project-layout") !== "1") return;
      sessionStorage.removeItem("topics-e2e-clear-project-layout");
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("topics-project-layout-")) localStorage.removeItem(k);
      }
    });
    await goToApp(page);
    await page.locator('[data-pane-id^="project:"]').first().click();
    await expect
      .poll(() => page.locator("[data-split-surface]").count(), {
        timeout: 20000,
        message: "the project window must draw a surface of its own",
      })
      .toBeGreaterThan(1);
    const projectSurface = (await page.locator("[data-split-surface]").count()) - 1;
    await expect
      .poll(async () => leaves(await readTree(page, projectSurface)).length, { timeout: 15000, message: "the project draws a leaf" })
      .toBeGreaterThan(0);
    return projectSurface;
  }

  /**
   * Where the dragged pane ended up: the axis of the split that HOLDS it, and
   * its index among that split's children.
   *
   * The axis is read from the PARENT split and not from the root, and that is
   * not a detail. A project surface is always a root `col` of rows, so a right
   * split builds `col(row(A,B))` and the root says `col` for a horizontal
   * gesture: measured on WebKit, where the first run of this row failed with
   * exactly that tree printed next to an expected `row`. The parent split is
   * the one the gesture actually created, at any depth, which is also what
   * makes this usable on a nested target.
   */
  async function landing(page: Page, projectSurface: number, paneFrag: string) {
    const tree = await readTree(page, projectSurface);
    const leaf = await leafOfPane(page, paneFrag);
    let axis: string | null = null;
    let at = -1;
    const walk = (node: TreeNode | null): void => {
      if (!node || node.kind !== "split") return;
      const idx = node.children.findIndex((c) => c.kind === "leaf" && c.id === leaf);
      if (idx >= 0) {
        axis = node.dir;
        at = idx;
      }
      for (const c of node.children) walk(c);
    };
    walk(tree);
    return { tree, ids: leaves(tree), axis, at };
  }

  test("PRJ-4: a ROOT pane splits in all four directions, four trees", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-04" });
    // One test and not four: the four rows differ only by the point aimed at,
    // and reading them side by side is what makes "the axis follows the edge"
    // checkable. Each direction reseeds, so none inherits the previous shape.
    const cases = [
      { edge: "right" as const, axis: "row", at: 1 },
      { edge: "left" as const, axis: "row", at: 0 },
      { edge: "bottom" as const, axis: "col", at: 1 },
      { edge: "top" as const, axis: "col", at: 0 },
    ];

    for (const c of cases) {
      const projectSurface = await openProject(page, request, [projectId, projectB]);
      expect(leaves(await readTree(page, projectSurface)), `${c.edge}: one group before the split`).toHaveLength(1);

      const body = await paneBodyBox(page, projectId);
      const res = await dragTabTo(page, `[data-pane-id*="${projectB}"]`, edgePoint(body, c.edge), { scope: PROJECT_PATH });
      expect(res.previewed, `${c.edge}: the band must accept the drop it previews`).toBe(true);

      await expect
        .poll(async () => leaves(await readTree(page, projectSurface)).length, {
          timeout: 8000,
          message: `${c.edge}: an accepted edge drop must add a leaf`,
        })
        .toBe(2);

      const got = await landing(page, projectSurface, projectB);
      // The axis is the direction, and the INDEX is the side: a right split
      // that lands the pane on the left is the same tree read backwards, and
      // only the position tells them apart.
      expect(got.axis, `${c.edge}: the split axis follows the edge -- ${shape(got.tree)}`).toBe(c.axis);
      expect(got.at, `${c.edge}: the dragged pane lands on the side it was aimed at -- ${shape(got.tree)}`).toBe(c.at);
    }
  });

  /**
   * A project column already split in two, and the id of the LOWER member.
   *
   * Built with the drag path rather than the menu, because the menu's "Dividi
   * in basso" is the same operation and the point here is the state it leaves:
   * the second level the rows below aim at.
   */
  async function stackedProject(page: Page, request: APIRequestContext, ids: string[]): Promise<number> {
    const projectSurface = await openProject(page, request, ids);
    const body = await paneBodyBox(page, ids[0]!);
    await dragTabTo(page, `[data-pane-id*="${ids[1]}"]`, edgePoint(body, "bottom"), { scope: PROJECT_PATH });
    await expect
      .poll(async () => {
        const t = await readTree(page, projectSurface);
        return splits(t).filter((s) => s.dir === "col" && s.children.length === 2).length;
      }, { timeout: 8000, message: "the setup needs ONE column split vertically in two" })
      .toBe(1);
    return projectSurface;
  }

  test("PRJ-5: on a NESTED pane the top/bottom band lands next to it, and the siblings keep their size", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-04" });
    for (const c of [
      { edge: "bottom" as const, at: 2 },
      { edge: "top" as const, at: 1 },
    ]) {
      const projectSurface = await stackedProject(page, request, [projectId, projectB, projectC]);
      const lower = await leafOfPane(page, projectB);
      const upper = await leafOfPane(page, projectId);

      // The flex-grow the stack slots carry. `CellSubStack` writes it on the
      // very element that publishes `data-split-leaf`, so this is the model's
      // own number and not a measurement of the pixels it produced.
      const before = await page.evaluate(() => {
        const out: Record<string, string> = {};
        for (const el of Array.from(document.querySelectorAll("[data-split-leaf]"))) {
          const id = el.getAttribute("data-split-leaf");
          if (id && (el as HTMLElement).style.flex) out[id] = (el as HTMLElement).style.flex;
        }
        return out;
      });

      const res = await dragTabTo(page, `[data-pane-id*="${projectC}"]`, edgePoint(await paneBodyBox(page, projectB), c.edge), {
        scope: PROJECT_PATH,
      });
      expect(res.previewed, `${c.edge}: a nested band must accept the drop it previews`).toBe(true);

      await expect
        .poll(async () => {
          const t = await readTree(page, projectSurface);
          return splits(t).filter((s) => s.dir === "col" && s.children.length === 3).length;
        }, { timeout: 8000, message: `${c.edge}: the slot lands INSIDE the pointed column, not beside it` })
        .toBe(1);

      const got = await landing(page, projectSurface, projectC);
      expect(got.ids, `${c.edge}: the column is still the whole surface -- ${shape(got.tree)}`).toHaveLength(3);
      expect(got.at, `${c.edge}: the new slot is adjacent to the pane pointed at -- ${shape(got.tree)}`).toBe(c.at);
      expect(got.ids.indexOf(lower) >= 0, `${c.edge}: the pointed member is still there`).toBe(true);

      // The half that the old `equalizeWidths` broke: splitting the pointed
      // slot must not redistribute the column, so a sibling nobody touched
      // keeps exactly the number it had.
      const after = await page.evaluate(() => {
        const out: Record<string, string> = {};
        for (const el of Array.from(document.querySelectorAll("[data-split-leaf]"))) {
          const id = el.getAttribute("data-split-leaf");
          if (id && (el as HTMLElement).style.flex) out[id] = (el as HTMLElement).style.flex;
        }
        return out;
      });
      expect(after[upper], `${c.edge}: the untouched sibling keeps its height -- ${JSON.stringify(after)}`).toBe(
        before[upper],
      );
    }
  });

  test("PRJ-6: on a NESTED pane the side band draws the COLUMN, and builds it", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-04" });
    const projectSurface = await stackedProject(page, request, [projectId, projectB, projectC]);
    const lower = await leafOfPane(page, projectB);

    await startDrag(page, `[data-pane-id*="${projectC}"]`, { scope: PROJECT_PATH });
    const point = edgePoint(await paneBodyBox(page, projectB), "right");
    expect(await dragOverPoint(page, point), "the side band of a nested pane must offer the gesture").toBe(true);

    // THE ONE PLACE A RECT IS THE RIGHT PROOF, and it is here because the claim
    // IS about pixels: a left/right release inserts a column as tall as the
    // whole row, so an outline drawn on the pointed SLOT would be a promise the
    // drop cannot keep. Everything else in this file reads the tree.
    expect(
      await page.locator("[data-grid-split-overlay]").count(),
      "still exactly one overlay for the gesture",
    ).toBe(1);
    const measured = await page.evaluate((leafId) => {
      const overlay = document.querySelector("[data-grid-split-overlay]");
      const slot = document.querySelector(`[data-split-leaf="${leafId}"]`);
      const column = slot?.closest("[data-group-cell]");
      if (!overlay || !slot || !column) return null;
      return {
        overlay: overlay.getBoundingClientRect().height,
        slot: slot.getBoundingClientRect().height,
        column: column.getBoundingClientRect().height,
      };
    }, lower);
    expect(measured, "the overlay, the slot and the hosting column must all be on screen").not.toBeNull();
    expect(
      Math.abs(measured!.overlay - measured!.column),
      `the preview covers the HOST COLUMN: ${JSON.stringify(measured)}`,
    ).toBeLessThanOrEqual(2);
    expect(
      measured!.overlay,
      `and is taller than the slot pointed at: ${JSON.stringify(measured)}`,
    ).toBeGreaterThan(measured!.slot + 2);

    await dropAtPoint(page, point);
    await endDrag(page, point);

    // And the outcome is that same column: the row gains one, the stack keeps
    // the two it had.
    await expect
      .poll(async () => {
        const t = await readTree(page, projectSurface);
        return splits(t).find((s) => s.dir === "row")?.children.length ?? 0;
      }, { timeout: 8000, message: "the release adds a column beside the hosting one" })
      .toBe(2);
    const after = await readTree(page, projectSurface);
    expect(
      splits(after).filter((s) => s.dir === "col" && s.children.length === 2).length,
      `the stack is untouched: ${shape(after)}`,
    ).toBe(1);
    expect(leaves(after), `three leaves in all: ${shape(after)}`).toHaveLength(3);
  });

  test("PRJ-7: a tab moved between two groups is in exactly one of them", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-04" });
    const projectSurface = await openProject(page, request, [projectId, projectB, projectC]);
    // Two groups first: projectC leaves for a column of its own.
    await dragTabTo(page, `[data-pane-id*="${projectC}"]`, edgePoint(await paneBodyBox(page, projectId), "right"), {
      scope: PROJECT_PATH,
    });
    await expect
      .poll(async () => leaves(await readTree(page, projectSurface)).length, { timeout: 8000, message: "two groups to move between" })
      .toBe(2);

    const before = await readTree(page, projectSurface);
    const label = await page.locator(`[data-pane-id*="${projectB}"] [data-testid="pane-tab-label"]`).first().textContent();
    const home = await leafOfPane(page, projectC);

    // The CENTRE of the other group's body: merge-as-tab, the one gesture that
    // moves a pane without touching the tree.
    const target = await paneBodyBox(page, projectC);
    const res = await dragTabTo(page, `[data-pane-id*="${projectB}"]`, center(target), { scope: PROJECT_PATH });
    expect(res.previewed, "the centre of ANOTHER group accepts the merge it previews").toBe(true);

    await expect
      .poll(() => leafOfPane(page, projectB).catch(() => ""), { timeout: 8000, message: "the pane must live in the group it was dropped into" })
      .toBe(home);

    // NOT DUPLICATED: one tab, once, in the whole document. A move that copies
    // is the failure this row exists for, and counting inside one bar cannot
    // see it.
    expect(
      await page.locator(`[data-pane-id*="${projectB}"]`).count(),
      "the moved tab exists once across every bar on screen",
    ).toBe(1);
    // NOT DEMOTED: same pane id, same label. This proves the pane arrived as
    // itself -- it does NOT prove the in-pane scroll or buffer survived, which
    // a cross-group move re-parents and this file has no honest probe for.
    expect(
      await page.locator(`[data-pane-id*="${projectB}"] [data-testid="pane-tab-label"]`).first().textContent(),
      "and it is still the same chat, not a fresh draft",
    ).toBe(label);
    expect(shape(await readTree(page, projectSurface)), "a move between groups creates no leaf").toBe(shape(before));
  });

  test("PRJ-8: the tree survives a reload", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-04" });
    const projectSurface = await stackedProject(page, request, [projectId, projectB, projectC]);
    // A column beside the stack, so the shape under test has both axes: a
    // single-axis tree would come back right by accident.
    await dragTabTo(page, `[data-pane-id*="${projectC}"]`, edgePoint(await paneBodyBox(page, projectB), "right"), {
      scope: PROJECT_PATH,
    });
    await expect
      .poll(async () => leaves(await readTree(page, projectSurface)).length, { timeout: 8000, message: "a row and a stack" })
      .toBe(3);

    const before = skeleton(await readTree(page, projectSurface));
    const panesBefore = (await page.locator('[data-split-surface]:last-of-type [data-pane-id]').allTextContents()).length;

    await page.reload();
    await page.locator('[data-pane-id^="project:"]').first().click();
    await expect
      .poll(() => page.locator("[data-split-surface]").count(), { timeout: 20000, message: "the project is drawn again" })
      .toBeGreaterThan(1);
    const projectAfter = (await page.locator("[data-split-surface]").count()) - 1;

    // Compared on the SKELETON: group ids are not part of the promise, the
    // arrangement is. A reload that rebuilt the same shape with new ids kept
    // what the user arranged, and that is what the requirement says.
    await expect
      .poll(async () => skeleton(await readTree(page, projectAfter)), {
        timeout: 15000,
        message: "the arrangement must come back as it was left",
      })
      .toBe(before);
    expect(
      (await page.locator('[data-split-surface]:last-of-type [data-pane-id]').allTextContents()).length,
      "and with the same number of panes in it",
    ).toBe(panesBefore);
  });

  test("PRJ-9: Escape during a drag leaves the tree and the console alone", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-06" });
    const projectSurface = await openProject(page, request, [projectId, projectB]);
    const before = shape(await readTree(page, projectSurface));

    // Listening only for the WINDOW of the gesture: the noise a page makes
    // while it boots is not what this row is about, and folding it in would
    // make the assertion a coin toss.
    const errors: string[] = [];
    const onConsole = (m: { type(): string; text(): string }) => {
      if (m.type() === "error") errors.push(m.text());
    };
    const onPageError = (e: Error) => errors.push(`uncaught: ${e.message}`);
    page.on("console", onConsole);
    page.on("pageerror", onPageError);

    await startDrag(page, `[data-pane-id*="${projectB}"]`, { scope: PROJECT_PATH });
    const point = edgePoint(await paneBodyBox(page, projectId), "right");
    expect(await dragOverPoint(page, point), "the band lit up before the cancel").toBe(true);
    // Escape, then the `dragend` a real browser sends on the source when it
    // cancels a drag -- and NO drop, which is what cancelling means. Same
    // shape as STD-9's release outside the window.
    await page.keyboard.press("Escape");
    await endDrag(page, point);

    page.off("console", onConsole);
    page.off("pageerror", onPageError);

    expect(shape(await readTree(page, projectSurface)), "a cancelled drag changes no tree").toBe(before);
    expect(
      await page.locator("[data-grid-split-overlay]").count(),
      "and leaves no preview painted behind it",
    ).toBe(0);
    expect(errors, `a cancelled drag must raise nothing: ${errors.join(" | ")}`).toEqual([]);
  });

  test("PRJ-10: the centre of your OWN group paints nothing", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-06" });
    const projectSurface = await openProject(page, request, [projectId, projectB]);
    const before = shape(await readTree(page, projectSurface));

    await startDrag(page, `[data-pane-id*="${projectB}"]`, { scope: PROJECT_PATH });
    const point = center(await paneBodyBox(page, projectB));
    await dragOverPoint(page, point);

    // The assertion is the PAINT, not the acceptance. The dragover still calls
    // preventDefault so the release is consumed here -- without it WKWebView
    // reads the drop as a drag-OUT and the pop-out path closes the pane -- but
    // a merge into the group the tab already lives in changes nothing, so
    // nothing may be promised.
    expect(
      await page.locator('[data-grid-split-overlay="center"]').count(),
      "the centre of your own group offers no merge",
    ).toBe(0);
    await dropAtPoint(page, point);
    await endDrag(page, point);

    expect(shape(await readTree(page, projectSurface)), "and the release changed nothing either").toBe(before);
  });

  test("STD-13: the bottom band builds one tree, whichever cell the tab came from", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "DNDSPLIT-05" });
    // Run one: the tab comes from the POOL.
    await openStandalone(page, request, [idA, idB, idC]);
    const cellA = await splitOff(page, idA, "Dividi a destra");
    const boxA = await boxOf(page, cellA);
    const bottom = { x: boxA.x + boxA.width / 2, y: boxA.y + boxA.height * 0.92 };
    expect(
      (await dragTabTo(page, `[data-pane-id="${idC}"]`, bottom)).previewed,
      "from the pool, the bottom band accepts",
    ).toBe(true);
    await expect
      .poll(async () => splits(await readTree(page)).filter((s) => s.dir === "col" && s.children.length === 2).length, {
        timeout: 5000,
        message: "a pool tab on the bottom band stacks the pointed column",
      })
      .toBe(1);
    const poolTree = await readTree(page);
    const poolHost = await leafOfPane(page, idA);
    let fromPool = "none";
    const walkPool = (node: TreeNode | null): void => {
      if (!node || node.kind !== "split") return;
      if (node.children.some((c) => c.kind === "leaf" && c.id === poolHost)) fromPool = skeleton(node);
      for (const c of node.children) walkPool(c);
    };
    walkPool(poolTree);
    expect(fromPool, "run one really built a column of two").toBe("col(leaf,leaf)");

    // Run two: the SAME tab, but it already has a cell of its own. This is the
    // divergence the row exists for -- the old code routed it down the
    // whole-cell path, where the same band built a FULL-WIDTH row instead.
    await openStandalone(page, request, [idA, idB, idC]);
    const cellA2 = await splitOff(page, idA, "Dividi a destra");
    const rootBefore = await readTree(page);
    const rootChildrenBefore = rootBefore?.kind === "split" ? rootBefore.children.length : 0;
    const boxA2 = await boxOf(page, cellA2);
    await dragTabTo(page, `[data-pane-id="${idC}"]`, {
      x: boxA2.x + boxA2.width - 10,
      y: boxA2.y + boxA2.height / 2,
    });
    // The precondition is an IDENTITY, not a count: idC must sit in a cell that
    // is not A's. A leaf count would also answer "how many other cells does the
    // grid happen to have", which is not what this row is about -- and on
    // WebKit it answered 4 where the shape under test was already right.
    await expect
      .poll(async () => (await cellOf(page, idC)) !== (await cellOf(page, idA)), {
        timeout: 5000,
        message: "idC gets a cell of its own",
      })
      .toBe(true);

    const boxA3 = await boxOf(page, await cellOf(page, idA));
    expect(
      (await dragTabTo(page, `[data-pane-id="${idC}"]`, {
        x: boxA3.x + boxA3.width / 2,
        y: boxA3.y + boxA3.height * 0.92,
      })).previewed,
      "from its own cell, the same band accepts the same way",
    ).toBe(true);
    // Compared on the COLUMN the gesture pointed at, not on the whole grid: the
    // requirement is about what that band builds, and the rest of the surface
    // is somebody else's business. `columnShape` is the skeleton of the split
    // that holds A -- `col(leaf,leaf)` when the tab stacked under it.
    const columnShape = async () => {
      const tree = await readTree(page);
      const leafId = await leafOfPane(page, idA);
      let found = "none";
      const walk = (node: TreeNode | null): void => {
        if (!node || node.kind !== "split") return;
        if (node.children.some((c) => c.kind === "leaf" && c.id === leafId)) found = skeleton(node);
        for (const c of node.children) walk(c);
      };
      walk(tree);
      return found;
    };
    await expect
      .poll(columnShape, {
        timeout: 5000,
        message: "same pointer, same band: the column must be the one the pool source built",
      })
      .toBe(fromPool);
    // Named separately because it is the actual symptom: a full-width row is a
    // new child of the ROOT, and the root must not have gained one.
    const rootAfter = await readTree(page);
    expect(
      rootAfter?.kind === "split" ? rootAfter.children.length : 0,
      "no full-width row was created",
    ).toBe(rootChildrenBefore);
  });
  /* ------------------------------------------------------------------ *
   *  D15: THE WHOLE GESTURE, NOT JUST ITS LAST POINT.
   *
   *  Every row above aims straight at the band. A real hand does not: it
   *  leaves the tab header, crosses the pane body (a chat's message list, a
   *  file tree) and only then reaches an edge. On the way each child it
   *  crosses gets a dragleave, and WebKit sends those with a NULL
   *  relatedTarget. Two defects lived on that path: the body's own file-drop
   *  handlers claimed the tab and stopped the layout from seeing it, and a
   *  null relatedTarget read as "left the pane", so the preview blinked off.
   *
   *  Sixteen gestures: two speeds x root/nested x four edges. SLOW commits a
   *  frame per step and checks the overlay at every one; FAST crosses the
   *  whole path inside one task, the way a flick outruns React. Both end on
   *  the same promise: the overlay painted at the edge is the tree built.
   * ------------------------------------------------------------------ */
  test.describe("D15: header to content to edge, slow and fast", () => {
    type Edge = "left" | "right" | "top" | "bottom";
    type Pt = { x: number; y: number };
    /** What one step of the path saw: the pointer's cell and every overlay painted. */
    interface Sample {
      at: Pt;
      pointerCell: { x: number; y: number; width: number; height: number } | null;
      overlays: { zone: string; cx: number; cy: number }[];
      fileFrame: boolean;
    }

    /** `n` evenly spaced points from `a` to `b`, `b` included and `a` not. */
    function segment(a: Pt, b: Pt, n: number): Pt[] {
      return Array.from({ length: n }, (_, i) => ({
        x: a.x + ((b.x - a.x) * (i + 1)) / n,
        y: a.y + ((b.y - a.y) * (i + 1)) / n,
      }));
    }

    /**
     * Move a live drag through `points`, the way a browser does: whenever the
     * element under the pointer changes, the old one gets a dragleave with a
     * NULL relatedTarget (WebKit's shape, the one that broke) and the new one
     * a dragenter; every step ends with a dragover. With `perFrame` the page
     * gets a frame after each step and the step is sampled.
     */
    async function sweep(page: Page, points: Pt[], perFrame: boolean): Promise<Sample[]> {
      return page.evaluate(
        async ({ points, perFrame }) => {
          const w = window as unknown as { __dndMatrix?: { dt: DataTransfer; src: Element }; __d15Prev?: Element | null };
          const held = w.__dndMatrix;
          if (!held) throw new Error("no drag in flight");
          const samples: Sample[] = [];
          const mk = (type: string, p: Pt) =>
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: held.dt,
              clientX: p.x,
              clientY: p.y,
              relatedTarget: null,
            });
          const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
          for (const p of points) {
            const el = document.elementFromPoint(p.x, p.y);
            if (!el) throw new Error(`no element at ${p.x},${p.y}`);
            const prev = w.__d15Prev ?? null;
            if (prev !== el) {
              if (prev) prev.dispatchEvent(mk("dragleave", p));
              el.dispatchEvent(mk("dragenter", p));
              w.__d15Prev = el;
            }
            el.dispatchEvent(mk("dragover", p));
            if (!perFrame) continue;
            await frame();
            await frame();
            const under = document.elementFromPoint(p.x, p.y);
            const cell = under?.closest("[data-group-cell]")?.getBoundingClientRect() ?? null;
            samples.push({
              at: p,
              pointerCell: cell ? { x: cell.x, y: cell.y, width: cell.width, height: cell.height } : null,
              overlays: Array.from(document.querySelectorAll("[data-grid-split-overlay]")).map((o) => {
                const r = o.getBoundingClientRect();
                return { zone: o.getAttribute("data-grid-split-overlay") ?? "", cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
              }),
              fileFrame: Array.from(document.querySelectorAll('[role="log"] p')).some((n) => n.textContent === "Drop files here"),
            });
          }
          return samples;
        },
        { points, perFrame },
      );
    }

    /** The overlay painted right now, with the group cell that holds its centre. */
    async function paintedOverlay(page: Page) {
      return page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("[data-grid-split-overlay]"));
        return all.map((o) => {
          const r = o.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const cell = Array.from(document.querySelectorAll("[data-group-cell]")).find((c) => {
            const b = c.getBoundingClientRect();
            return cx > b.left && cx < b.right && cy > b.top && cy < b.bottom;
          });
          return { zone: o.getAttribute("data-grid-split-overlay") ?? "", cell: cell?.getAttribute("data-group-cell") ?? null };
        });
      });
    }

    /** The group cell that holds the leaf of `paneFrag`. */
    async function cellOfPane(page: Page, paneFrag: string): Promise<string | null> {
      return page.evaluate((frag) => {
        const tab = document.querySelector(`[data-pane-id*="${frag}"]`);
        const leaf = tab?.closest("[data-split-leaf]");
        return leaf?.closest("[data-group-cell]")?.getAttribute("data-group-cell") ?? null;
      }, paneFrag);
    }

    /**
     * Root: two chats in one group, the second dragged to an edge of the
     * first. Nested: a column already split in two, the third chat dragged
     * from the upper group to an edge of the LOWER slot. Expected trees are
     * PRJ-4's and PRJ-5/6's: the same gestures, reached the long way round.
     */
    const EXPECT: Record<"root" | "nested", Record<Edge, { axis: string; at: number }>> = {
      root: {
        left: { axis: "row", at: 0 },
        right: { axis: "row", at: 1 },
        top: { axis: "col", at: 0 },
        bottom: { axis: "col", at: 1 },
      },
      nested: {
        left: { axis: "row", at: 0 },
        right: { axis: "row", at: 1 },
        top: { axis: "col", at: 1 },
        bottom: { axis: "col", at: 2 },
      },
    };

    for (const speed of ["slow", "fast"] as const) {
      for (const level of ["root", "nested"] as const) {
        test(`D15 ${speed} ${level}: header, body, then each of the four edges`, async ({ page, request }) => {
          test.info().annotations.push({ type: "spec", description: "DNDSPLIT-07" });
          for (const edge of ["left", "right", "top", "bottom"] as const) {
            const ids = level === "root" ? [projectId, projectB] : [projectId, projectB, projectC];
            const projectSurface =
              level === "root" ? await openProject(page, request, ids) : await stackedProject(page, request, ids);
            const dragged = level === "root" ? projectB : projectC;
            const target = level === "root" ? projectId : projectB;
            const targetCell = await cellOfPane(page, target);
            const beforeLeaves = leaves(await readTree(page, projectSurface)).length;

            const errors: string[] = [];
            const onConsole = (m: { type(): string; text(): string }) => {
              if (m.type() === "error") errors.push(m.text());
            };
            const onPageError = (e: Error) => errors.push(`uncaught: ${e.message}`);
            page.on("console", onConsole);
            page.on("pageerror", onPageError);

            const tabSelector = `[data-testid="panel-tab-bar"] [data-pane-id*="${dragged}"]`;
            const header = center(await boxOf(page, tabSelector));
            const body = center(await paneBodyBox(page, dragged));
            const end = edgePoint(await paneBodyBox(page, target), edge);
            const path =
              speed === "slow"
                ? [header, ...segment(header, body, 8), ...segment(body, end, 10)]
                : [header, body, end];

            await page.evaluate(() => {
              (window as unknown as { __d15Prev?: Element | null }).__d15Prev = null;
            });
            await startDrag(page, tabSelector, { scope: PROJECT_PATH });
            const samples = await sweep(page, path, speed === "slow");

            // DURING the path: one indicator at most, never the chat's own
            // file frame, and whatever is painted sits in the cell under the
            // pointer, not in the cell the drag left or in a tab.
            for (const s of samples) {
              const where = `${edge} at ${Math.round(s.at.x)},${Math.round(s.at.y)}`;
              expect(s.fileFrame, `${where}: the chat body must not claim a tab as a file`).toBe(false);
              expect(s.overlays.length, `${where}: one indicator per gesture`).toBeLessThanOrEqual(1);
              for (const o of s.overlays) {
                const c = s.pointerCell;
                expect(c, `${where}: an overlay is painted while the pointer is on no pane`).not.toBeNull();
                const inside = !!c && o.cx > c.x && o.cx < c.x + c.width && o.cy > c.y && o.cy < c.y + c.height;
                expect(inside, `${where}: overlay ${o.zone} belongs to the pane under the pointer`).toBe(true);
              }
            }

            // AT the edge: exactly one overlay, of that edge, on the target's cell.
            const painted = await paintedOverlay(page);
            expect(painted, `${edge}: the edge band paints one overlay`).toHaveLength(1);
            expect(painted[0]!.zone, `${edge}: the overlay names the edge aimed at`).toBe(edge);
            expect(painted[0]!.cell, `${edge}: the overlay sits on the target pane`).toBe(targetCell);

            const accepted = await dropAtPoint(page, end);
            await endDrag(page, end);
            page.off("console", onConsole);
            page.off("pageerror", onPageError);
            expect(accepted, `${edge}: the release is accepted where the preview promised`).toBe(true);

            await expect
              .poll(async () => leaves(await readTree(page, projectSurface)).length, {
                timeout: 8000,
                message: `${speed} ${level} ${edge}: an accepted edge drop adds a leaf`,
              })
              .toBe(beforeLeaves + 1);
            const got = await landing(page, projectSurface, dragged);
            const want = EXPECT[level][edge];
            expect(got.axis, `${speed} ${level} ${edge}: axis follows the previewed edge -- ${shape(got.tree)}`).toBe(want.axis);
            expect(got.at, `${speed} ${level} ${edge}: side follows the previewed edge -- ${shape(got.tree)}`).toBe(want.at);
            expect(await page.locator("[data-grid-split-overlay]").count(), `${edge}: no preview left behind`).toBe(0);
            expect(errors, `${edge}: the gesture raises nothing: ${errors.join(" | ")}`).toEqual([]);
          }
        });
      }
    }
  });
});
