# Performance Spec

Performance contract for the Topics App client. All targets are testable
assertions — instrumentation and automated enforcement are future work.

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
- Tooling to enforce these assertions (Playwright harness, CI gate, bundle
  size CI check) is explicitly out of scope for this spec — this file is the
  contract, not the enforcement.
