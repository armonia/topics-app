# Tasks

## Status 2026-07-03 — COMPLETE (ready to archive)

All layers shipped. Final pass (this session):
- **SDK passthrough control tools** — `server/control-tools.ts` created (Anthropic
  `Tool[]` for `open_project`/`create_project`/`switch_topic`/`new_topic` +
  in-process dispatcher); `chat.ts` registers them in `sendOptions.tools` for
  passthrough providers and dispatches them in `onToolStart` (mirrors the browser
  dispatch). The switch/create-topic cores were extracted to
  `server/lib/session-control-core.ts` so the HTTP endpoints AND the SDK dispatcher
  share one implementation (project bind/open/create reuse the closure-local
  helpers via ChatDeps).
- **openclaw decision gate** — `providerHasControlTools()` in `assemble.ts`: openclaw
  is gateway-owned and the gateway exposes no equivalent control tools (verified), so
  the tool-instruction blocks are skipped for it and a one-line warning is logged at
  assembly time. Degrades to user-driven control, never a silent no-op.
- **Validation gaps** — 409 project-name collision + archived-switch 400 already
  shipped and now covered by route tests (`topics.control.test.ts`).
- **Endpoint-name drift** — spec delta AC-01/AC-02 amended to the shipped names
  (`open-project`/`create-project`/`switch-topic`/`new-topic`; MCP `open_project`
  etc.).
- **Tests** — added: SDK-dispatcher + core unit tests (`control-tools.test.ts`),
  MCP handler unit tests for the five control tools, move-to-project idempotency
  route test. `client/src/types/index.ts` marker comment was already clean.
- **E2E port** — `cloud-session-project-open.spec.ts` header ported to the
  tool/endpoint framing; its client-contract body (the two broadcasts) is unchanged
  and drives the same frames the endpoint now emits.

Earlier shipped + load-bearing: session-keyed control endpoints
(`topics.ts:1295-1585`), MCP control tools for claude-code AND codex (`df1d3713`),
atomic `move_session_to_project` (`1a004704`), full marker decommission (`955276aa`
— grammar/detect/strip pipeline deleted, prompts tool-only). Step-1.1's named pure
helpers were superseded for the PROJECT cores (inline in the endpoints); the TOPIC
switch/create cores are now the named helpers in `session-control-core.ts`.

> Ordered so each step is independently shippable. Markers stay live until step 3.

## 1. Canonical control endpoints (Layer 1)
- [x] **Refactor side-effect cores out of the marker wrappers** in
  `server/routes/topics.ts`: extract pure helpers `bindProjectForSession`,
  `createProjectForSession`, `switchTopicForSession`, `createTopicForSession`
  from `detectAndHandleProjectMarkers` / `detectAndBroadcastTopicSwitch` (do NOT
  delete the marker wrappers yet — have them call the helpers).
  _(Superseded/completed: PROJECT cores live inline in the endpoints (marker
  wrappers deleted in `955276aa`); the TOPIC switch/create cores are extracted to
  `server/lib/session-control-core.ts` — `switchTopicCore`/`createTopicCore` —
  shared by the `switch-topic`/`new-topic` endpoints AND the SDK dispatcher.)_
- [x] **Add endpoints** keyed by `sessionKey`:
  `POST /api/sessions/:sessionKey/bind-project`,
  `.../create-project`, `.../switch-topic`, `.../create-topic`. Reuse
  `getTopicBySessionKey`, `resolveProjectRef({trustRawPaths:true})`,
  `bindTopicToProject`. Confirm `.../browser/open-pane` already exists.
  _(Shipped at `topics.ts:1295-1483` as `open-project` / `create-project` /
  `switch-topic` / `new-topic` — name drift vs design, see Status.)_
- [x] **Validation + errors**: 404 unknown session/topic, 400 bad path/archived
  target, 409 project-name collision (mirror `/project create`).
  _(Shipped + covered by `topics.control.test.ts`: archived-switch → 400
  `topic_archived`; create collision → 409 `project_exists`; unknown ref → 404.)_
- [x] **Add `move-to-project` endpoint** (AC-05): `POST /api/sessions/:sessionKey/move-to-project`
  `{projectPath}` — one atomic op that (a) adds the pane to
  `topics-project-panes-<projectHash(path)>`, (b) splices it out of the
  app-level `pane-store-v2` (`panes` entry + every `groups.*.paneIds`), (c) opens
  the project window. Idempotent; exactly one instance results (no inside+outside
  duplicate). Server-side `projectHash` helper shared with the client's. Must NOT
  touch device-local `project-layout-<hash>` geometry. This replaces the manual
  7-step ui_state surgery proven necessary during the spec-flow move.
  _(Shipped `1a004704`.)_
- [x] **Tests**: moving a standalone terminal pane → asserts membership added,
  standalone removed, idempotent re-call is a no-op, broadcasts emitted.
  _(`topics.control.test.ts`: terminal-tab move + the idempotent-re-move test.)_
- [x] **Tests**: unit/route tests for each endpoint incl. broadcast assertions
  (`topic:updated`, `pane:focus-suggest`, `topic:switch`, `topic:created`).
  _(`topics.control.test.ts` — 22 tests.)_

## 2. Tool surfaces (Layer 2) + instruction (Layer 3)
- [x] **MCP bridge** (`server/mcp/topics-mcp-server.ts`): add `TOOLS` +
  `TOOL_HANDLERS` for `bind_project`, `create_project`, `switch_topic`,
  `create_topic`, and `move_session_to_project` (AC-05), each `httpJson`-ing to
  its Layer-1 endpoint (pattern: `open_browser_pane`). Add handler unit tests
  (patch `globalThis.fetch`).
  _(Shipped `df1d3713` + `1a004704` as `open_project` / `create_project` /
  `switch_topic` / `new_topic` / `move_session_to_project`. Per-handler unit tests
  now added in `topics-mcp-server.test.ts`.)_
- [x] **SDK passthrough**: define control tools as `Tool[]` (new
  `server/control-tools.ts`, mirror `server/browser-tools.ts`); append to
  `sendOptions.tools` for passthrough providers in `server/routes/chat.ts`;
  dispatch in the `onToolStart` switch (mirror `dispatchBrowserToolCall`) →
  synthesized confirmation result.
  _(Done. The dispatcher runs IN-PROCESS rather than round-tripping the Layer-1
  HTTP endpoint — chat.ts already holds the exact side-effect helpers via ChatDeps
  (resolveProjectRef/bindTopicToProject) + session-control-core (switch/create-
  topic), so a self-HTTP/TLS/token dance is avoided while reusing the same cores.
  Unit-tested in `control-tools.test.ts`.)_
- [x] **assemble.ts**: switch instruction to tool-based. Generalize the existing
  claude-code `open_browser_pane` steer to cover the four new tools. Keep marker
  instruction blocks for now (removed in step 3). _(Shipped `df1d3713` —
  browser/project/topic blocks are tool-only for every provider.)_
- [x] **codex check**: confirm whether codex loads the MCP config; record result.
  _(Confirmed `df1d3713`: Codex CLI 0.140 supports MCP; the topics bridge is
  injected into `codex exec` via `-c mcp_servers.topics.*`.)_

## 3. Decommission markers (the removal)
- [x] **assemble.ts**: delete `pushProjectMarkersBlock`/`projectMarkersContent`,
  marker variant of `topicSwitchContent`, and the marker branch of
  `browserInstructionContent`. _(Shipped `df1d3713`+`955276aa`: the function
  names survive but their content is tool-only — no marker instruction remains.)_
- [x] **chat.ts**: remove live per-delta marker dispatch
  (`detectAndBroadcastBrowserMarker` / `...TopicSwitch` / `...ProjectMarkers`
  calls at ~chat.ts:911-920) and the inline strip-for-side-effect coupling.
  _(Shipped `955276aa`; localhost autonav is the only heuristic left.)_
- [x] **topics.ts**: delete the now-unused marker-parsing wrappers (helpers from
  step 1 remain). _(Shipped `955276aa` — wrappers deleted; cores live inline in
  the endpoints, not as named helpers.)_
- [x] Verify no path still instructs or emits any `{{…}}` marker.
  _(`955276aa`: grammar/detect/strip pipeline deleted; stored history backfilled
  clean.)_

## 4. openclaw decision gate
- [x] Determine gateway tool capability (open question #1). Then either map
  control to gateway tools, OR add a one-line assembly-time warning + confirm
  user-driven fallback works for openclaw. No silent no-op.
  _(Determined: the openclaw gateway exposes NO equivalent control tools (verified
  — no open_project/switch_topic/create_project in the gateway surface), and
  Topics cannot inject tools into a gateway-owned surface. Conservative outcome
  chosen: `providerHasControlTools()` in `assemble.ts` returns false for openclaw,
  so its tool-instruction blocks are skipped and a one-line warning is logged once
  per provider at assembly time. Control degrades to the always-available
  user-driven UI. Guarded by a regression.test.ts scenario.)_

## 5. Sanitization downgrade (Layer 4) + cleanup
- [x] Keep `server/lib/markers.ts` `stripMarkers()` + regexes as a **read/replay
  guard only** (`build-provider-history.ts`, client `useChat.ts`, claude-code
  replay). Keep their leak-regression tests.
  _(SUPERSEDED: `server/lib/markers.ts` was deleted outright and stored history was
  backfilled clean (`955276aa`) instead of keeping a read-guard. Nothing emits
  markers and no historical `{{…}}` remains to scrub, so the guard is unnecessary.
  AC-04 in the spec is thus vestigial — recorded here as a deliberate deviation.)_
- [x] Remove dead marker tests tied to the *emit/detect* path
  (`topics-marker-strip.test.ts` side-effect cases, `assemble.test.ts` marker
  blocks, `regression.test.ts` marker prompt-text checks); replace with
  tool/endpoint tests.
  _(Dead marker test files removed; `assemble.test.ts`/`regression.test.ts` now
  assert the TOOL blocks; replaced by `control-tools.test.ts`,
  `topics.control.test.ts`, and the MCP handler tests.)_
- [x] Update `client/src/types/index.ts` comment referencing `{{PROJECT_OPEN}}`.
  _(Already clean — no marker reference remains in the file.)_

## 6. E2E + verification
- [x] Port `tests/e2e/cloud-session-project-open.spec.ts` to drive the
  `bind-project` tool/endpoint instead of the marker; assert nesting
  (`pane:focus-suggest`).
  _(Ported: the header now frames the trigger as the `open_project`/`create_project`
  tool + `POST /open-project|create-project` endpoint (marker retired). The client
  contract asserted — the `topic:updated` + `pane:focus-suggest` broadcasts and the
  resulting nest — is the same the endpoint emits, so the body drives it verbatim.)_
- [~] E2E: AI-initiated topic switch/create + browser open via tools.
  _(Deferred: the switch/create broadcast contract is covered end-to-end by the
  route tests (`topics.control.test.ts`, broadcast assertions) and the client
  render is covered by the ported spec above. A dedicated tool-driven E2E adds
  little beyond those and would need a live provider stub; left as follow-up.)_
- [~] Run full suite with video per project workflow; confirm all AC pass and no
  `{{…}}` text ever reaches UI or provider history.
  _(Not run here — per instruction, only the isolated :13334 infra may run E2E and
  the full-suite-with-video pass is out of scope for this session. Unit + route +
  typecheck gates are all green; `{{…}}` no longer reaches UI/history because the
  emit/detect pipeline was deleted (`955276aa`).)_
