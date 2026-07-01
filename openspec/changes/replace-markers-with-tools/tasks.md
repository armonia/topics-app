# Tasks

## Status 2026-07-01

Shipped and load-bearing: session-keyed control endpoints (`topics.ts:1295-1483`), MCP control tools for claude-code AND codex (`df1d3713`), atomic `move_session_to_project` (`1a004704`), full marker decommission (`955276aa` — grammar/detect/strip pipeline deleted, prompts tool-only). Step-1.1's named pure helpers were superseded: the marker wrappers were deleted outright and the side-effect cores live inline in the endpoints.

Remaining:
- **SDK passthrough control tools** (`server/control-tools.ts` does not exist; `chat.ts` has no control-tool dispatch) — claude/openai SDK providers still have no AI-initiated control channel.
- **openclaw decision gate** (step 4) — gateway capability never determined; no assembly-time warning.
- **Validation gaps**: 409 project-name collision + archived-topic-switch 400 — being fixed now by another agent (in-flight).
- **Endpoint-name drift vs `design.md`**: shipped as `open-project` / `new-topic` (not `bind-project` / `create-topic`); the spec delta (AC-01) should be amended to the shipped names before archive.
- **Missing tests**: route/unit tests for the endpoints incl. broadcast assertions, MCP handler unit tests, move-to-project idempotency tests, and the step-6 E2E port (`cloud-session-project-open.spec.ts` still marker-era) — plus `client/src/types/index.ts:678` still references `{{PROJECT_OPEN}}` (step 5.3).
- **Step 5 nuance**: `markers.ts` was deleted entirely (history backfilled clean) instead of being kept as a read/replay guard — 5.1/5.2 as written are superseded; replacement tool/endpoint tests still missing.

> Ordered so each step is independently shippable. Markers stay live until step 3.

## 1. Canonical control endpoints (Layer 1)
- [ ] **Refactor side-effect cores out of the marker wrappers** in
  `server/routes/topics.ts`: extract pure helpers `bindProjectForSession`,
  `createProjectForSession`, `switchTopicForSession`, `createTopicForSession`
  from `detectAndHandleProjectMarkers` / `detectAndBroadcastTopicSwitch` (do NOT
  delete the marker wrappers yet — have them call the helpers).
- [x] **Add endpoints** keyed by `sessionKey`:
  `POST /api/sessions/:sessionKey/bind-project`,
  `.../create-project`, `.../switch-topic`, `.../create-topic`. Reuse
  `getTopicBySessionKey`, `resolveProjectRef({trustRawPaths:true})`,
  `bindTopicToProject`. Confirm `.../browser/open-pane` already exists.
  _(Shipped at `topics.ts:1295-1483` as `open-project` / `create-project` /
  `switch-topic` / `new-topic` — name drift vs design, see Status.)_
- [ ] **Validation + errors**: 404 unknown session/topic, 400 bad path/archived
  target, 409 project-name collision (mirror `/project create`).
- [x] **Add `move-to-project` endpoint** (AC-05): `POST /api/sessions/:sessionKey/move-to-project`
  `{projectPath}` — one atomic op that (a) adds the pane to
  `topics-project-panes-<projectHash(path)>`, (b) splices it out of the
  app-level `pane-store-v2` (`panes` entry + every `groups.*.paneIds`), (c) opens
  the project window. Idempotent; exactly one instance results (no inside+outside
  duplicate). Server-side `projectHash` helper shared with the client's. Must NOT
  touch device-local `project-layout-<hash>` geometry. This replaces the manual
  7-step ui_state surgery proven necessary during the spec-flow move.
  _(Shipped `1a004704`.)_
- [ ] **Tests**: moving a standalone terminal pane → asserts membership added,
  standalone removed, idempotent re-call is a no-op, broadcasts emitted.
- [ ] **Tests**: unit/route tests for each endpoint incl. broadcast assertions
  (`topic:updated`, `pane:focus-suggest`, `topic:switch`, `topic:created`).

## 2. Tool surfaces (Layer 2) + instruction (Layer 3)
- [x] **MCP bridge** (`server/mcp/topics-mcp-server.ts`): add `TOOLS` +
  `TOOL_HANDLERS` for `bind_project`, `create_project`, `switch_topic`,
  `create_topic`, and `move_session_to_project` (AC-05), each `httpJson`-ing to
  its Layer-1 endpoint (pattern: `open_browser_pane`). Add handler unit tests
  (patch `globalThis.fetch`).
  _(Shipped `df1d3713` + `1a004704` as `open_project` / `create_project` /
  `switch_topic` / `new_topic` / `move_session_to_project`; tools are asserted in
  the tool-list tests but the per-handler unit tests are still missing — see
  Status.)_
- [ ] **SDK passthrough**: define control tools as `Tool[]` (new
  `server/control-tools.ts`, mirror `server/browser-tools.ts`); append to
  `sendOptions.tools` for passthrough providers in `server/routes/chat.ts`;
  dispatch in the `onToolStart` switch (mirror `dispatchBrowserToolCall`) →
  Layer-1 endpoint → synthesized confirmation result.
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
- [ ] Determine gateway tool capability (open question #1). Then either map
  control to gateway tools, OR add a one-line assembly-time warning + confirm
  user-driven fallback works for openclaw. No silent no-op.

## 5. Sanitization downgrade (Layer 4) + cleanup
- [ ] Keep `server/lib/markers.ts` `stripMarkers()` + regexes as a **read/replay
  guard only** (`build-provider-history.ts`, client `useChat.ts`, claude-code
  replay). Keep their leak-regression tests.
- [ ] Remove dead marker tests tied to the *emit/detect* path
  (`topics-marker-strip.test.ts` side-effect cases, `assemble.test.ts` marker
  blocks, `regression.test.ts` marker prompt-text checks); replace with
  tool/endpoint tests.
- [ ] Update `client/src/types/index.ts` comment referencing `{{PROJECT_OPEN}}`.

## 6. E2E + verification
- [ ] Port `tests/e2e/cloud-session-project-open.spec.ts` to drive the
  `bind-project` tool/endpoint instead of the marker; assert nesting
  (`pane:focus-suggest`).
- [ ] E2E: AI-initiated topic switch/create + browser open via tools.
- [ ] Run full suite with video per project workflow; confirm all AC pass and no
  `{{…}}` text ever reaches UI or provider history.
