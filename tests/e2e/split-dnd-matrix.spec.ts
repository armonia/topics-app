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
import { test, expect, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { resetPaneStore, resetProjectPanes, seedProjectPane, createTopic, deleteTopic } from "./helpers/api-fixtures";
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
        const leaf = child.getAttribute("data-split-leaf");
        const dir = child.getAttribute("data-split-node");
        if (leaf !== null) out.push({ kind: "leaf", id: leaf });
        else if (dir !== null) out.push({ kind: "split", dir, children: walk(child) });
        else out.push(...walk(child));
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
async function dragTabTo(
  page: Page,
  tabSelector: string,
  target: { x: number; y: number },
  opts: { scope: string; dropAtEnd?: boolean } = { scope: "main" },
): Promise<{ previewed: boolean }> {
  return page.evaluate(
    ({ tabSelector, target, scopeType, dropAtEnd }) => {
      const src = document.querySelector(tabSelector);
      if (!src) throw new Error(`no drag source at ${tabSelector}`);
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      // A source that did not fill the payload is not a tab -- fail loudly
      // rather than assert on a drag that never carried anything.
      if (!dt.types.includes("application/x-pane-tab")) throw new Error("dragstart carried no PANE_TAB payload");
      if (!dt.types.includes(scopeType)) dt.setData(scopeType, "1");

      const el = document.elementFromPoint(target.x, target.y);
      if (!el) throw new Error("no element at drop point");
      const mk = (type: string) =>
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: target.x,
          clientY: target.y,
        });
      el.dispatchEvent(mk("dragenter"));
      const over = mk("dragover");
      el.dispatchEvent(over);
      // `preventDefault` on the last dragover IS the answer "yes, you may drop
      // here" -- so it is also the honest read of whether the target offered
      // the gesture at all. That is the promise the drop has to keep.
      const previewed = over.defaultPrevented;
      if (dropAtEnd !== false) el.dispatchEvent(mk("drop"));
      src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      return { previewed };
    },
    { tabSelector, target, scopeType: paneTabScopeType(opts.scope), dropAtEnd: opts.dropAtEnd },
  );
}

/** Centre of the project surface's Nth pane body, and its box. */
async function paneBox(page: Page, idx = 0) {
  const box = await page.locator("[data-split-surface] [data-split-leaf]").nth(idx).boundingBox();
  if (!box) throw new Error(`no pane body at index ${idx}`);
  return box;
}

test.describe("Drag-and-drop and split: the case table", () => {
  test.describe.configure({ mode: "serial" });

  let topic: { id: string; name: string };

  test.beforeAll(async ({ request }) => {
    topic = await createTopic(request, `dnd-matrix-${Date.now()}`);
  });

  test.afterAll(async ({ request }) => {
    if (topic?.id) await deleteTopic(request, topic.id).catch(() => {});
    await resetProjectPanes(request, PROJECT_PATH).catch(() => {});
  });

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
});
