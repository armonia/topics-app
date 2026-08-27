# Performance Spec

Performance contract for the Topics App client. All targets are testable
assertions. Six of them are enforced in CI today; the rest are still contract
only. Which is which is written below, and nowhere else.

## Which budgets block CI (2026-08-27)

Until today this file opened with "automated enforcement is future work" while
`check:ink` was failing the `check` job. Two statements, opposite verdicts, and
whoever looked at a red CI could not tell which one held. The one that was
false is the one that got corrected: the enforcement exists.

THE RULE, for every performance gate in the `check` job of `.github/workflows/ci.yml`:

- **exit 1 = measured, and over budget. It BLOCKS.** A budget that was really
  exceeded stops the run. Raising the number to get past the gate is not an
  available move: it switches the gate off and leaves it green.
- **exit 2 = not measured.** The bench abstained (shared runner out of scale, no
  baseline for this machine, the probe never produced a number). The pipeline
  continues, and the run carries an annotated `::warning` saying so. "I did not
  measure" is a THIRD outcome and never a silent green.

The six, and what each one blocks on:

| gate | script | blocks on | abstains on |
|---|---|---|---|
| Bundle size | `check:bundle` | over budget | never (deterministic: same bytes on any machine) |
| Route latency | `check:route-latency` | over budget | pipe out of scale, or no baseline for this runner |
| Click-to-ink | `check:ink` | over budget | the probe produced no number |
| Scroll fluidity | `check:scroll-fluidity` | dropped frames over budget | the machine delivers no frames at all |
| Kanban drag | `check:drag` | frame time over budget | no baseline recorded |
| Long-session growth | `check:growth` | growth ratio over budget | too few cycles, or heap unreadable |

Everything else in this file is a contract without a gate: it is read by a
person, not by CI, and it cannot make a run red.

The rest of the targets below are advisory in the same sense they always were:
they describe the reference machine (Apple Silicon, Chrome stable, production
build), and a number measured somewhere else is an observation, not a verdict.

## Cumulative Layout Shift (CLS)

- Initial chat render: CLS <= 0.1 measured from navigation start to first
  interactive.
- Pane swap (tab switch, sidebar toggle, pane focus change): CLS <= 0.1 over
  the 1s window following the user action.
- Measured via `PerformanceObserver({ type: 'layout-shift' })` in a Playwright
  harness; reported per-interaction.

## Load Time

- Cold cache (localhost dev server, fresh reload, disabled cache):
  document ready -> first interactive < 2.5s.
- Hot cache (second reload, service worker warm, module graph cached):
  document ready -> first interactive < 800ms.
- "First interactive" = ChatInput accepts keystrokes and tab bar responds to
  click.

## Sidebar Push / Split Resize Frame Cost (no feature-disable)

The sidebar collapse/expand PUSH and tab-split divider drag MUST stay at the
display's max refresh with N live terminals — and MUST NOT achieve it by
disabling/snapping/hiding anything under load.

- **Forbidden**: animating a LAYOUT property (e.g. `paddingLeft`/`width`) on a
  container of N terminal panes — it relayouts every `.xterm` box each frame,
  O(N). Equally forbidden: dodging that by snapping the animation off, hiding
  terminals (`content-visibility:hidden`), or freezing content under load.
- **Required**: the visible push is a COMPOSITOR-only transform (FLIP — commit
  the final pad in one reflow, animate `transform:translateX` to 0). See
  `client/src/hooks/useSidebarFlipPush.ts`.
- **Acceptance (mechanism, lock-proof)**: `performance/sidebar-flip-bench.html`
  — per-op forced-reflow cost of `transform` MUST be <= 0.5ms median at every N
  (compositor-only, O(1)); `paddingLeft` scales with N. Measured 2026-06-29
  (Chromium): paddingLeft 1.3ms (N=2) / 3.0 (N=5) / 5.0 (N=8) median; transform
  0ms at every N (1300x–5000x). WebKit layout is slower, so the real Tauri gap is
  larger — the FLIP removes it entirely.
- **Acceptance (composited, VERIFIED lock-proof in headless Chromium)**: rAF
  frame deltas during the actual 200ms slide, measured in headless Chromium
  (renders offscreen → unaffected by the locked physical screen),
  `performance/sidebar-flip-bench.html`. Measured 2026-06-29, N=16 terminals
  (~52k spans): OLD animated paddingLeft = 41.9ms/frame median (~24fps), **6/6
  frames > 33ms (all dropped)** — matches the documented WebKit "~25fps"; FLIP
  transform = 8.3ms/frame median (~120fps), **0 frames > 33ms**. The headline
  "0 dropped frames during the slide" is met by the FLIP and catastrophically
  missed by the old paddingLeft path.
- **Acceptance (REAL WebKit engine, VERIFIED lock-proof)**: forced-reflow layout
  cost in headless WebKit (Playwright, AppleWebKit/605.1.15 Version/26.0 — the same
  engine as Tauri's WKWebView; synchronous layout timing, not rAF, so it is reliable
  even though headless WebKit throttles rAF). `performance/sidebar-flip-webkit-bench.cjs`.
  Measured 2026-06-29: animating paddingLeft forces **8ms (N=2) / 20 (N=5) / 33 (N=8)
  / 66 (N=16)** of layout PER FRAME — at N>=5 it exceeds the 16.7ms/frame budget and
  at N=8 it is **2x the budget (33ms)**, which is exactly why the slide dropped to
  ~25fps and why the snap existed. The FLIP transform = **0ms at every N** (compositor,
  O(1)). WebKit layout is ~6x slower than Chromium here, so the FLIP matters MORE on
  the real engine.
- **Acceptance (live Tauri WKWebView, confirmatory, needs unlocked screen)**:
  `TOPICS_FPS_SELFTEST` on a live Tauri build → composited 0 frames > 33ms + native-pane
  lockstep. Confirms the system-WebKit + native-pane case; the engine cost is already
  proven on real WebKit above. See PORTING-PLAN §8b.
- **Divider/split**: already DOM-direct flex + coalesced fits (no per-frame
  feature-disable); measured 0 dropped frames steady-state.

## Layout Shift During Streaming

- Message arrival (any chunk of a streamed assistant reply) MUST NOT reflow:
  - the tab bar (top),
  - the sidebar (left),
  - the ChatInput area (bottom).
- Acceptance: Playwright screenshot diff of a stream with 50+ chunks, with
  the three zones above masked as no-change regions. Alternative: manual
  eyeball check against a known-good recording.
- Only the message list region is permitted to grow.

## Pane-State LWW Latency (Phase 30 PANE-02)

- Cross-tab propagation (same browser, two tabs of the app):
  - WS path: `server_seq` update on tab A reflected on tab B within 300ms.
  - GET fallback path: reflected within 500ms.
- Measured from PUT ack on tab A to store commit on tab B.
- Applies to any syncable pane-store field (see `selectSyncableSnapshot`).

## Broadcast Strategy (Phase 30 finding #11)

The server keeps the per-broadcast payload small so fan-out scales with the
write, not with the whole `ui_state` table. This is what keeps the 300ms WS
target above achievable once `ui_state` grows past a handful of keys.

- **Single-key PUT (`PUT /api/ui-state/:key`)** → broadcasts `ui-state:updated`
  with the written value only. Payload is O(write-size). Unchanged since
  migration 012.
- **Bulk PUT (`PUT /api/ui-state`)** → broadcasts `ui-state:patch` with only
  the keys the request modified (`entries[key] = { data, payload_version,
  server_seq }`). Payload is O(written-keys × avg-value-size) — was previously
  O(total-keys × avg-value-size) because the bulk path re-broadcast a full
  `ui-state:init` envelope. This is the fix that actually makes the 300ms
  target hold under load.
- **WS open** → still sends a full `ui-state:init` for back-compat. Clients
  that don't recognise `ui-state:patch` continue to work; they just miss the
  delta and pick up any changes on the next reconnect / GET.
- Every broadcast carries `sourceClientId` (per finding #10) so the writing
  tab can suppress its own echo without depending on a `server_seq` ack round-trip.

## Bundle Size

- Main client bundle: <= 800 kB gzipped.
- Current baseline per Phase 30 notes: ~704 kB gzipped.
- Measured post-build via `vite build` stats output; any single-PR increase
  above 800 kB blocks merge.

## Phase 30 — Browser-in-Chat

The `/ws/browser/:contextId` bridge + CDP screencast deliver a remote browser
view inside any topic. The following targets are CI-enforced via
`tests/e2e/browser-ws-streaming.spec.ts` and asserted against
`tests/e2e/perf-baseline.json` (single source of truth for numeric values).

### FPS (frame rate)

- Target: >= 15 sustained over a 2s window on a page with continuous animation.
- Measurement: `page.routeWebSocket(/\/ws\/browser\//)` intercept, count
  `BrowserWsMessage` payloads with `type==='frame'` over a 2s window.
- Floor (test fail): < 30 frames in the 2s window (= 15 FPS).
- Target page: a static fixture page with a CSS `@keyframes` continuous
  animation served from the test server (no external network).

### Input latency p95

- Target: < 150ms over 20+ click samples.
- Measurement: per click, record `t0` at outbound `{type:'input',action:'click'}`
  WS send, `t1` at next inbound `{type:'frame'}` arrival; `dt = t1 - t0`.
- Compute p95 = `samples.sort()[Math.ceil(0.95 * (n-1))]`.
- Floor (test fail): p95 >= 150.

### RAM / BrowserContext

- Target: < 200MB resident per active BrowserContext (Chromium process slice).
- Measurement: server-side via `process.memoryUsage().rss` delta after 5
  contexts spawned (RAM-per-context = total / 5 averaged).
- Note: this is a smoke metric; not asserted in CI today (manual via
  `manual-only-checks` block in VALIDATION.md). Captured here as the contract
  for follow-up CI.

### Bandwidth

- Target: < 1.5 Mbps average over a 2s window of normal browsing.
- Measurement: sum byte length of all WS payloads received in window /
  window seconds * 8 / 1000 (Mbps).
- Floor (test fail): > 1500 kbps over the 2s window.

### CLS (Cumulative Layout Shift) — iframe fallback only

- Target: CLS <= 0.1 when localhost URLs render via the `<iframe>` fallback.
- Measurement: `PerformanceObserver({type:'layout-shift'})` aggregated over
  the 2s window after iframe mount.
- Note: Playwright-driven contexts are not subject to CLS (they're rendered
  server-side as JPEG); this metric only applies to the iframe fallback path
  (localhost / *.local).

### First-frame time

- Target: < 2000ms from `/ws/browser/:id` `open` event to first inbound
  `{type:'frame'}` message.
- Measurement: WS open timestamp via `routeWebSocket` instrumentation,
  compared to first frame arrival.
- Floor (test fail): > 2000.

### Fallback-http grace

- Target: < 4000ms from WS close event to client `connectionState ===
  'fallback-http'` (REST polling resumes, indicator pillola turns yellow).
- Measurement: trigger WS close server-side, observe class transition on
  `[data-testid="browser-connection-indicator"]`.
- Note: client internal timer is `FALLBACK_DELAY_MS = 2000` (useRemoteBrowser.ts:56).
  4s ceiling = 2s timer + 2s margin for slowMo:300 + retries:1 + shared CI scheduling.

### Methodology notes

- All targets apply to the isolated test server (port 13334) with a clean
  /tmp/topics-test-data/ DB and headless Chromium (default Playwright config).
- Variance budget: +/-15% per run (CI uses retries:1 to absorb flakes from
  scheduling jitter on shared CI hardware).
- Baseline values are stored in `tests/e2e/perf-baseline.json` and updated
  as the implementation evolves; tests assert against these values
  (not hard-coded numbers in the spec) so the baseline can drift without
  changing test code.

## Notes

- All thresholds apply to production builds on a reference machine
  (Apple Silicon, Chrome stable). Dev-mode numbers are advisory.
- Tooling to enforce these assertions was out of scope when this file was
  written. It no longer is: six of the targets have a gate in the `check` job,
  listed at the top of this file with what each one blocks on. For the others
  this file is still the contract and not the enforcement.
