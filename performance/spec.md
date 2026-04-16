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

## Notes

- All thresholds apply to production builds on a reference machine
  (Apple Silicon, Chrome stable). Dev-mode numbers are advisory.
- Tooling to enforce these assertions (Playwright harness, CI gate, bundle
  size CI check) is explicitly out of scope for this spec — this file is the
  contract, not the enforcement.
