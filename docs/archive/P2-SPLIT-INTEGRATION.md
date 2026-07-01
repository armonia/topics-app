# P2 — Split-system integration guide

The new split engine is **fully built and isolated** on this branch
(`feat/tauri-migration-overnight`). Nothing imports it yet, so the current
PanelGrid / GroupLayout engines are untouched and the default build is unchanged.
This is the step-by-step to wire it in **behind a flag**, verify byte-identical
geometry, then flip the flag — done in the **main checkout** (it has a working
`tsc`; the worktree's was broken: node absent).

## What exists (all pure / tested / esbuild-verified)

| Module | Role |
|---|---|
| `client/src/state/layout/layoutTree.ts` | The model: `LayoutNode = leaf \| split{dir,children:[{weight,node}]}` + pure reducers (`splitLeaf`, `closeLeaf`, `moveLeaf`, `resizeAt`, `setWeightAt`, `equalizeAt`, `equalizeAll`, `normalize`) + `computeRects` (geometry, gutter-aware). 35 tests. |
| `client/src/state/layout/legacyAdapters.ts` | `gridRowsToTree`/`groupRowsToTree` (legacy → tree) + `treeToGridRows`/`treeToGroupRows` (tree → legacy). Round-trip-tested = lossless for legacy-originated trees. 11 tests. |
| `client/src/state/layout/splitController.ts` | `dropZone(rect,px,py)` (5-zone) + `pxToWeightDelta`. 10 tests. |
| `client/src/components/Layout/SplitTree.tsx` | Recursive renderer: nested flex w/ `flex:<weight> 1 0%`, `renderLeaf(id)` prop, `<Divider>` at z-50 reporting `(deltaPx, bandPx)` + firing `topics:pane-resize-start/-end`. |
| `client/src/hooks/useSplitController.ts` | Stateful glue: owns the `LayoutNode`, maps gestures → reducers. |

## Step 1 — Add the flag (default OFF)

In `client/src/types/index.ts` `AppSettings`, add `splitTreeEngine: boolean` (or
reuse an existing experimental-flags pattern). Default `false` everywhere it's
seeded. Surface it in Settings → Appearance (or Features) as experimental.

## Step 2 — First, golden-test the adapters against the REAL renderer

Before rendering anything, prove `gridRowsToTree`/`groupRowsToTree` +
`computeRects` reproduce the CURRENT geometry. In `legacyAdapters.test.ts` add a
golden block that, for a corpus of saved layouts (grab a few real
`usePanelGridPersistence` / `projectLayoutSync` snapshots), asserts
`computeRects(gridRowsToTree(rows, rowHeights), CONTAINER)` matches the rects the
current PanelGrid flex produces (or at least the per-leaf width/height fractions).
This is the migration-safety gate — only proceed when it's green on real data.

## Step 3 — Render behind the flag (standalone first, it's simpler)

In `PanelGrid.tsx`, when `appSettings.splitTreeEngine`:
- `const ctl = useSplitController(useMemo(() => gridRowsToTree(gridRows, gridRowHeights), [...]))`
  — hydrate once; keep it in sync with external changes via `ctl.setTree` (or
  re-hydrate when the persisted rows change from another client).
- Render `<SplitTree node={ctl.tree} gutter={GUTTER} onResize={ctl.onResize}
  renderLeaf={(key) => /* the SAME per-cell JSX PanelGrid renders today, keyed by GridItem.key */} />`.
- Persist on change: `const { rows, rowHeights } = treeToGridRows(ctl.tree)` →
  feed `setGridRows` / `setGridRowHeights` (so persistence + cross-device sync keep
  working in the legacy shape during the transition).
- Wire the gestures: tab close → `ctl.close(key)`; split affordance →
  `ctl.split(targetKey, edge, newKey)`; tab drag-drop → `ctl.dropOnLeaf(srcKey,
  tgtKey, targetRect, px, py)` (`'center'` → add as a tab in that cell, your
  existing tab-into path); double-click divider → `ctl.equalize(path)`.

Then do the same in `GroupLayout`/`useProjectLayout` with `groupRowsToTree` /
`treeToGroupRows` and `renderLeaf = (groupId) => <the group's tab bar + active pane>`.
**Standalone == "a project with one implicit group per leaf"** — same `<SplitTree>`,
different `renderLeaf`.

## Step 4 — Native browser panes: gutter + webview inset (fixes the "fa schifo")

`<SplitTree gutter={6}>` reserves a 6px divider strip. For a browser pane (native
WKWebView/WebContentsView composited ABOVE the DOM), inset its bounds by the gutter
so the divider lives in a webview-FREE strip that's hittable from both sides — i.e.
in `NativeBrowserPlaceholder` / `useTauriBrowser` `setBounds`, shrink the rect by
the gutter on the shared edges (NATIVE_VIEW_GUTTER is currently 0). No z-index hacks,
no park-on-hover. This fixes Electron too.

## Step 5 — Deterministic occlusion (replace the global MutationObserver)

`browserOcclusion.ts` parks EVERY browser webview whenever ANY overlay opens. Replace
with a small `useOverlay()` registry (every popover already routes through
`popoverStyles.ts`): on open, register the overlay's rect; park ONLY the browser
panes whose slot (`computeRects`) geometrically intersects it. Deterministic,
leak-free, no app-wide blink, and it catches Radix popovers that toggle via
`data-state` (which the childList MutationObserver misses).

## Step 6 — Free wins the tree gives you

`equalizeAll()` (one command), keyboard resize (`setWeightAt` on ⌘⌥arrows),
maximize-pane (a render-time override that ignores siblings, tree untouched), and a
uniform tab→any-edge drop-split on BOTH surfaces — none expressible in the current
two-engine model.

## Rollout

Flag OFF by default → dogfood with it ON → once geometry + gestures match on real
layouts, make ON the default and delete the legacy PanelGrid/GroupLayout render
paths (keep `gridWidths.ts` math primitives + the persistence shapes via the reverse
adapters). The `topics:pane-resize-start/-end` events, keep-alive `visitedKeys`, and
`PANE_ID_REMAP` stay unchanged — `<SplitTree>` is drop-in at the render boundary.

## Note on this branch

Built overnight in an isolated worktree to avoid clobbering the concurrent
browser-pane work on `main` (NativeBrowserPlaceholder/GroupLayout/PaneTabBar/
useRemoteBrowser). Merge AFTER that work lands; the only expected conflicts are in
GroupLayout/PaneTabBar at Step 3 (the render swap), which you do by hand anyway.
