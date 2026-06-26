# Overnight Tauri Migration Loop

Autonomous, unattended run that hardens and completes the Electron→Tauri migration
in **isolation**, so the main checkout (a concurrent browser-pane session + the
user's daily setup) is never disturbed.

- **Worktree (work HERE only):** `/Users/zorahrel/Projects/topics-app-tauri-migration`
- **Branch:** `feat/tauri-migration-overnight` (off `main` @ e5026f7)
- **Deadline:** **2026-06-26 10:00 Europe/Rome** (string compare key `202606261000`)
- **NEVER touch** `/Users/zorahrel/Projects/topics-app` (main checkout).

## Loop protocol (every wake-up)

1. `TZ=Europe/Rome date +%Y%m%d%H%M`. If `>= 202606261000` → **STOP**: write the
   final summary at the bottom of this file, commit it, do **not** reschedule.
2. Else read this file's backlog + progress log and `git log --oneline -15` to see
   what's done. Pick the next task by priority.
3. Implement it in the worktree. **Verify before committing:**
   - `cd desktop-tauri/src-tauri && cargo build --release` compiles, and/or
   - `cd client && npx vite build` succeeds, and/or
   - `bun test <pure module>.test.ts` passes for touched pure modules.
   - Do **NOT** launch the Tauri GUI (port :13333 would clash with the user's
     running app; runtime visual verification is for the user tomorrow).
4. Commit working state with an **explicit pathspec** + a clear conventional
   message (no `Co-Authored-By` trailer). Append a one-line progress entry below.
   Only commit GREEN states. If something breaks and can't be fixed in a couple of
   steps, **revert that change** and move to a different task.
5. `ScheduleWakeup` (~120s) with the same loop prompt to continue.

Keep every commit focused, reversible, and green. A partial/incomplete feature must
sit behind a flag so the **default** build never breaks. Ultracode is on — use the
Workflow tool for big parallelizable chunks when it helps.

## Backlog (priority order — safe/high-value first, riskiest P2 integration last)

1. **BUG (fresh user report):** closing the sidebar leaves a transparent seam/line
   that slips under the floating cards. The sidebar's per-region vibrancy (or the
   `.floating-splits` gap) isn't re-measured/cleared on collapse. Fix in
   `useFloatingVibrancy` (retarget on sidebar width→0 / `sidebar-pre-collapsed`)
   and/or the gap CSS. Verify the region list drops the sidebar rect on collapse.
2. **P4 — IPC surface:** native `theme.setResolved` (a `set_theme` Rust command:
   NSWindow appearance + re-tint the vibrancy views) wired through the shell;
   scoped native notifications (`tauri-plugin-notification`, rewire
   `useCompletionNotifier` off the web fallback under Tauri);
   `onNavigateToTopic`/`reportFocusedTopic` events.
3. **P5 — process/perf/tray/updater/release:** honest multi-process perf
   attribution (child WKWebView pids via responsibility API / `proc_pid_rusage`
   `ri_phys_footprint`); tray icon + dynamic menu + dock badge (state stays in the
   client WS layer); `tauri-plugin-updater` + a `getUpdaterApi` Tauri branch;
   `tauri-release.yml` (tauri-action, universal-apple-darwin, reuse the existing
   APPLE_* notarization secrets) gated on the same tag.
4. **P6 — polish:** empty-space window drag (sidebar scroll container + empty-state
   pane → `data-tauri-drag-region=deep`, but mark interactive rows `false` so they
   stay clickable — watch the "tab bloccata" trap); replace the 250ms drag-region
   MutationObserver with declarative attributes; finish the native menu
   (Topics/Help/Window items, zoom, force-reload-clear-cache); `.tauri-mac` CSS
   titlebar inset (or drop the promise); notch safe-area verify.
5. **Cleanup / solidify:** finish the `isElectron`→`isDesktop` sweep (PaneTabBar,
   PaneAddMenu, useCompletionNotifier — paths deferred earlier); remove dead
   scaffolding; `tsc -b` clean for client + server; all `bun:test` pure-module
   tests green; make sure NOTHING regresses the default (Electron/web) build.
6. **P2 — split rewrite integration (BIGGEST, riskiest — keep behind a flag):**
   build on the committed `layoutTree.ts` engine: (a) `gridRowsToTree` /
   `groupRowsToTree` adapters + golden geometry tests (byte-identical vs the
   current renderer — note `gridRowHeights`, and the `heights`-includes-primary
   substack convention); (b) `<SplitTree>` recursive renderer + `useSplitController`
   (resize + 5-zone DnD) consuming `computeRects` with a gutter; (c) a single
   `<Divider>` at z-50; (d) the explicit overlay registry replacing
   `browserOcclusion`'s global MutationObserver; (e) gutter + webview-bounds inset
   so dividers next to a browser pane are hittable. ALL behind a settings flag
   (default OFF) so the current engines stay the default until verified by the
   user. Land it in small green steps (adapters+tests first).

## Progress log (newest first)

- **P2 <SplitTree> renderer + <Divider> DONE** (esbuild/vite verified). New
  client/src/components/Layout/SplitTree.tsx: one recursive renderer drawing a
  LayoutNode as nested flex with the `flex: <weight> 1 0%` invariant (replaces
  PanelGrid's row/col + GroupLayout's row/cellStacks render), `renderLeaf(id)`
  prop (decoupled), dividers in the gutter at z-50 reporting a pixel delta +
  firing topics:pane-resize-start/-end (so the per-region vibrancy freezes/snaps).
  ADDITIVE / behind the P2 flag, not wired in. NOTE: the worktree's `tsc` binary
  is broken through the symlinked node_modules (npx/direct → exit 127), so this is
  esbuild-verified (syntax + imports) + explicitly-typed by hand; a full `tsc`
  type-check + the actual renderer-swap integration are the user-verified step
  tomorrow (in the main checkout). The P2 logic it consumes is fully unit-tested.
- **Cleanup: PaneAddMenu project-actions under Tauri DONE** (vite green). Flipped
  PaneAddMenu's `isElectron` gate to the shell `isDesktop`, so "Apri / Crea
  Progetto" (+ the ⌘N hint) now show under Tauri — reachable now that the
  dialog-plugin `selectDirectory` works. File: client/src/components/Shared/PaneAddMenu.tsx.
  (useCompletionNotifier still left on the web-Notification fallback under Tauri —
  it works; native scoped notifications are a deferred improvement, not a fix.)
- **P5 hide-to-tray window lifecycle DONE** (cargo build green). The window's
  CloseRequested now HIDES to the tray (red button / ⌘W park the app) instead of
  quitting; a real quit (tray "Esci" + a custom ⌘Q menu item replacing the
  predefined quit) sets a `QUITTING` flag so the close passes through — avoids the
  classic "CloseRequested-prevent traps ⌘Q" bug. Recoverable even if the tray is
  invisible: re-launch → single-instance shows the hidden window. File:
  desktop-tauri/src-tauri/src/lib.rs. Needs runtime check (close hides; ⌘Q/Esci quit).
- **P5 system tray (baseline) DONE** (cargo build green). Added the `tray-icon` +
  `image-png` Tauri features and a tray with Show/Quit in setup() — a hidden window
  is now reachable again (Electron had a tray; Tauri had none). Uses the bundle's
  default icon. Unread / Claude-phase status + dock badge wiring (client WS layer)
  is a later step. File: desktop-tauri/src-tauri/src/lib.rs. Needs runtime check
  (tray appears in the menu bar; Show/Quit work).
- **P5 Tauri release pipeline DONE** (YAML validates, injection-safe). New
  `.github/workflows/tauri-release.yml` (tauri-action, universal-apple-darwin +
  win + linux, draft release + updater manifest) on a SEPARATE `tauri-v*` tag so
  shipping Tauri is opt-in during migration. Reuses the Electron Apple secrets
  (APPLE_ID/TEAM_ID/APP_SPECIFIC_PASSWORD, MAC_CSC_LINK→APPLE_CERTIFICATE). NEW
  secrets the user must add before a signed/auto-updating release:
  `APPLE_SIGNING_IDENTITY`, `TAURI_SIGNING_PRIVATE_KEY(+_PASSWORD)` (run
  `cargo tauri signer generate`). Unsigned builds still produce runnable artifacts.
  NOTE: can't run CI locally — needs a real tag push to validate end-to-end.
- **P2 controller geometry helpers DONE** (10 tests green). `splitController.ts`:
  `dropZone(rect, px, py, edgeFrac)` → 5-zone (left/right/top/bottom/center, corners
  resolve to the closest edge, out-of-bounds clamps) for tab-drag-to-edge drop-split,
  and `pxToWeightDelta(bandPx, deltaPx)` to turn a divider pixel-drag into a
  `resizeAt` weight delta. Pure/additive — the React hook that owns drag STATE will
  consume these at integration. Files: client/src/state/layout/splitController.ts (+test).
- **P2 reverse adapters + round-trip DONE** (11 tests green). `treeToGridRows` /
  `treeToGroupRows` decompose a tree back to the legacy row/col/sub-stack shape
  (lossless for any legacy-originated tree; a deeper-than-legacy tree flattens
  defensively, never throws). The round-trip test (legacy → tree → legacy) PROVES
  the forward adapters preserve every key + width + height — the migration-safety
  property. Files: client/src/state/layout/legacyAdapters.ts (+ test). Still pure/
  additive (nothing imports it).
- **P2 legacy→tree adapters DONE** (8 unit tests green). `legacyAdapters.ts`:
  `gridRowsToTree(PanelGridRow[], gridRowHeights)` + `groupRowsToTree(GroupLayoutRow[],
  rowHeights)` → one `LayoutNode`. Handles rows (col-split by rowHeights), columns
  (row-split by widths), and per-column sub-stacks (col-split by cellStacks heights,
  which INCLUDE the primary at index 0); single-child bands collapse so a plain pane
  → bare leaf; corrupt stack heights fall back to equal. Both project + standalone
  also carry `rowHeights` (confirmed useProjectLayout:269). Pure/additive — nothing
  imports it yet. NOTE: these are STRUCTURAL+geometry unit tests, not golden-vs-the-
  -real-renderer (can't run the renderer headless); the byte-identical golden check
  lands at integration. Files: client/src/state/layout/legacyAdapters.ts (+ test).
- **P4 theme sync DONE** (build green: vite + cargo). Added a Rust `set_theme`
  command (sets NSWindow appearance Aqua/DarkAqua → the traffic lights AND the
  per-region NSVisualEffectViews re-tint to match light/dark for free) + a Tauri
  branch in `useTheme.ts` (was electronAPI-only → dead under Tauri). Files:
  desktop-tauri/src-tauri/src/lib.rs, client/src/hooks/useTheme.ts. Needs runtime
  visual check (light/dark toggle re-tints chrome).
- **Sidebar-seam bug (task #1) — DEFERRED, needs GUI repro by user.** Investigated:
  the CSS already zeroes the collapsed sidebar's gap margin (index.css:1346,
  `[role=navigation][aria-label="Topics sidebar"][style*="width: 0px"] { margin:0 }`),
  and the vibrancy region logic should drop the sidebar rect on collapse (collect()
  filters `w>1`, so a width-0 sidebar is removed). So the seam isn't an obvious CSS
  or region-list bug. Most likely candidates to check WITH the GUI: (a) the content
  `[data-split-card]`'s 2px left margin not being clipped by the `[data-split-surface]`
  `-2px` pull once the sidebar (the former left element) is gone → a 2px transparent
  strip at x=0; (b) a region-update lag during the ~200ms `sidebar-transition` (the
  120ms settle + 700ms poll eventually correct it, but the transient could read as
  "strange"). NOT fixed blind (can't verify visually overnight) — flagged for the
  user. A safe candidate fix once confirmed: clip the content surface flush-left
  when the sidebar is collapsed, and/or flush the vibrancy regions on the sidebar
  `transitionend`.
- (loop start) worktree created, backlog set. Vibrancy frost CONFIRMED working
  (the `zPosition=-1` removal fixed it). Sidebar-collapse seam bug is task #1.
