# Replace Text Markers with Structured Tool Calls

## What
Retire the entire text-marker control subsystem — all five families
`{{PROJECT_OPEN}}`, `{{PROJECT_CREATE}}`, `{{TOPIC_SWITCH}}`, `{{TOPIC_NEW}}`,
`{{BROWSER}}` — and replace it with **structured tool calls** dispatched to a
small set of **canonical, session-keyed HTTP control endpoints**.

Concretely:
- **Add** canonical control endpoints (single source of truth for each
  side-effect), keyed by `sessionKey`:
  - `POST /api/sessions/:sessionKey/bind-project` (replaces `PROJECT_OPEN`)
  - `POST /api/sessions/:sessionKey/create-project` (replaces `PROJECT_CREATE`)
  - `POST /api/sessions/:sessionKey/switch-topic` (replaces `TOPIC_SWITCH`)
  - `POST /api/sessions/:sessionKey/create-topic` (replaces `TOPIC_NEW`)
  - `POST /api/sessions/:sessionKey/browser/open-pane` (already exists — used by `BROWSER`)
- **Expose** these as tools per provider tier:
  - **CLI providers** (claude-code, codex): add tools to the MCP bridge
    (`server/mcp/topics-mcp-server.ts`) — same pattern as the existing
    `open_browser_pane` tool.
  - **SDK providers** (claude, openai): register the same control tools in
    `sendOptions.tools` passthrough (same pipe as `browserTools`).
- **Remove** the marker grammar emit/instruct/detect path:
  - system-prompt marker instruction blocks in `server/context/assemble.ts`,
  - the three live detect/dispatch functions in `server/routes/topics.ts`
    (`detectAndBroadcastBrowserMarker`, `detectAndBroadcastTopicSwitch`,
    `detectAndHandleProjectMarkers`) and their calls in `server/routes/chat.ts`.
- **Keep** `stripMarkers()` (`server/lib/markers.ts`) as a **read-path legacy
  guard only**, so historical transcripts that already contain `{{…}}` never
  resurface in the UI or provider replay. Nothing new emits markers.

## Why
- **Fragility.** Markers are detected by scanning streamed text deltas with
  regexes, including an unclosed-tail case for chunk splits. This has already
  caused a production leak (`AUDIT-2026-06-19.md` #4: `PROJECT_*` leaked into
  provider history because two pipelines stripped a divergent subset). The
  grammar must be kept in sync across ≥6 strip sites (server + client).
- **Security smell.** Because a marker is just text, prompt injection can emit
  `{{PROJECT_OPEN:/etc}}`; the code defends with an `isKnownProject` gate
  (`topics.ts:626`) — a guard that only exists because the channel is untyped.
- **The replacement already exists and is preferred.** The MCP tool
  `open_browser_pane` already supersedes `{{BROWSER}}`, and `assemble.ts` already
  steers claude-code to the tool instead of the marker. We are generalizing a
  pattern the codebase already endorses, not inventing one.
- **`/api/open-project` is the wrong tool** for nesting a session (it only
  broadcasts "open a project window"; it does not bind the current topic). The
  canonical endpoints make "bind + nest" a typed, idempotent action.

## Scope
**In scope**
- New control endpoints + their wiring to existing side-effect functions
  (`bindTopicToProject`, topic switch/create, browser navigate).
- MCP tools for bind-project / create-project / switch-topic / create-topic.
- SDK passthrough tool definitions + `onToolStart` dispatch for the above.
- Removal of marker instruction blocks, detection functions, and live dispatch.
- Spec updates: `context`, `topics`, `projects`, `remote-browser`, `chat`.

**Out of scope / explicit limitations**
- **openclaw (gateway) provider.** Its tool surface is owned by the gateway, not
  this app — we cannot inject tools into it from here. Two acceptable outcomes,
  to be confirmed before the openclaw task is implemented:
  1. the gateway already exposes equivalent control tools → we map to them; or
  2. it does not → openclaw sessions lose **AI-initiated** control and rely on
     **user-driven** control (sidebar drag / context-menu / `/project`), which
     keeps working. This is low-impact (cloud path is secondary; UI unaffected).
  Removing the markers must NOT silently break openclaw — it must degrade to the
  user-driven path, logged.
- No database schema changes. No new dependencies.
- Existing `/api/command` `/project` slash command and `/api/open-project`
  remain as-is (user-driven affordances).

## Risks
- **Cross-provider divergence** (the central risk): after removal, control is
  only AI-initiated on providers that have a tool channel. Mitigated by the
  user-driven UI path remaining for all providers, and by the openclaw decision
  above.
- **Legacy transcripts.** Mitigated by retaining `stripMarkers()` on read/replay.
- **SDK single-turn tools.** claude/openai don't feed tool results back in-turn
  (`claude.ts:131-136`). Acceptable: these control actions are fire-and-forget
  side-effects; the tool returns a short confirmation string and the UI updates
  via the existing broadcast. No multi-turn loop required.
