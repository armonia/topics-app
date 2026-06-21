# Tasks

> Ordered so each step is independently shippable. Markers stay live until step 3.

## 1. Canonical control endpoints (Layer 1)
- [ ] **Refactor side-effect cores out of the marker wrappers** in
  `server/routes/topics.ts`: extract pure helpers `bindProjectForSession`,
  `createProjectForSession`, `switchTopicForSession`, `createTopicForSession`
  from `detectAndHandleProjectMarkers` / `detectAndBroadcastTopicSwitch` (do NOT
  delete the marker wrappers yet — have them call the helpers).
- [ ] **Add endpoints** keyed by `sessionKey`:
  `POST /api/sessions/:sessionKey/bind-project`,
  `.../create-project`, `.../switch-topic`, `.../create-topic`. Reuse
  `getTopicBySessionKey`, `resolveProjectRef({trustRawPaths:true})`,
  `bindTopicToProject`. Confirm `.../browser/open-pane` already exists.
- [ ] **Validation + errors**: 404 unknown session/topic, 400 bad path/archived
  target, 409 project-name collision (mirror `/project create`).
- [ ] **Add `move-to-project` endpoint** (AC-05): `POST /api/sessions/:sessionKey/move-to-project`
  `{projectPath}` — one atomic op that (a) adds the pane to
  `topics-project-panes-<projectHash(path)>`, (b) splices it out of the
  app-level `pane-store-v2` (`panes` entry + every `groups.*.paneIds`), (c) opens
  the project window. Idempotent; exactly one instance results (no inside+outside
  duplicate). Server-side `projectHash` helper shared with the client's. Must NOT
  touch device-local `project-layout-<hash>` geometry. This replaces the manual
  7-step ui_state surgery proven necessary during the spec-flow move.
- [ ] **Tests**: moving a standalone terminal pane → asserts membership added,
  standalone removed, idempotent re-call is a no-op, broadcasts emitted.
- [ ] **Tests**: unit/route tests for each endpoint incl. broadcast assertions
  (`topic:updated`, `pane:focus-suggest`, `topic:switch`, `topic:created`).

## 2. Tool surfaces (Layer 2) + instruction (Layer 3)
- [ ] **MCP bridge** (`server/mcp/topics-mcp-server.ts`): add `TOOLS` +
  `TOOL_HANDLERS` for `bind_project`, `create_project`, `switch_topic`,
  `create_topic`, and `move_session_to_project` (AC-05), each `httpJson`-ing to
  its Layer-1 endpoint (pattern: `open_browser_pane`). Add handler unit tests
  (patch `globalThis.fetch`).
- [ ] **SDK passthrough**: define control tools as `Tool[]` (new
  `server/control-tools.ts`, mirror `server/browser-tools.ts`); append to
  `sendOptions.tools` for passthrough providers in `server/routes/chat.ts`;
  dispatch in the `onToolStart` switch (mirror `dispatchBrowserToolCall`) →
  Layer-1 endpoint → synthesized confirmation result.
- [ ] **assemble.ts**: switch instruction to tool-based. Generalize the existing
  claude-code `open_browser_pane` steer to cover the four new tools. Keep marker
  instruction blocks for now (removed in step 3).
- [ ] **codex check**: confirm whether codex loads the MCP config; record result.

## 3. Decommission markers (the removal)
- [ ] **assemble.ts**: delete `pushProjectMarkersBlock`/`projectMarkersContent`,
  marker variant of `topicSwitchContent`, and the marker branch of
  `browserInstructionContent`.
- [ ] **chat.ts**: remove live per-delta marker dispatch
  (`detectAndBroadcastBrowserMarker` / `...TopicSwitch` / `...ProjectMarkers`
  calls at ~chat.ts:911-920) and the inline strip-for-side-effect coupling.
- [ ] **topics.ts**: delete the now-unused marker-parsing wrappers (helpers from
  step 1 remain).
- [ ] Verify no path still instructs or emits any `{{…}}` marker.

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
