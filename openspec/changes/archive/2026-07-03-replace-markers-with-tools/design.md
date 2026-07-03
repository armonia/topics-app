# Design — Replace Text Markers with Structured Tool Calls

## Problem recap
The model drives five app side-effects by emitting invisible text tokens
(`{{NAME:body}}`) that the server detects mid-stream, acts on, and strips. The
channel is untyped, duplicated across many strip sites, security-gated, and has
already leaked. We replace it with typed tool calls routed to canonical
endpoints, and decommission the marker emit/detect path.

## Architecture

### Layer 1 — Canonical control endpoints (single source of truth)
Each side-effect gets ONE HTTP endpoint, keyed by `sessionKey`. They wrap the
*existing* side-effect functions so behavior (and broadcasts) are unchanged.

| Endpoint | Wraps | Broadcasts (unchanged) |
|---|---|---|
| `POST /api/sessions/:sessionKey/bind-project` `{projectPath}` | `bindTopicToProject(topicId, dir, {focus:true})` + `resolveProjectRef(.., {trustRawPaths:true})` | `topic:updated`, `pane:focus-suggest` |
| `POST /api/sessions/:sessionKey/create-project` `{name}` | scaffold workspace dir + `CLAUDE.md`, then bind | `topic:updated`, `pane:focus-suggest` |
| `POST /api/sessions/:sessionKey/switch-topic` `{topicId}` | topic-switch logic from `detectAndBroadcastTopicSwitch` | `topic:switch` |
| `POST /api/sessions/:sessionKey/create-topic` `{title}` | new-topic logic from `detectAndBroadcastTopicSwitch` | `topic:created`, `topic:switch` |
| `POST /api/sessions/:sessionKey/browser/open-pane` `{url}` | existing handler | `browser:navigate` |
| `POST /api/sessions/:sessionKey/move-to-project` `{projectPath}` | add to `topics-project-panes-<hash>` + splice out of `pane-store-v2` (panes + `groups.*.paneIds`) + open project window | `ui-state:updated` (×2), `open-project` |

> `move-to-project` is the de-duplicated, atomic version of the manual flow
> (membership add + standalone removal + window open). It MUST leave exactly one
> instance of the pane — inside the project. This is the operation a "Claude Code
> tab", which is NOT a chat-topic, needs; `bind-project` above covers chat-topics.
> The split geometry (`project-layout-<hash>`) is device-local and is NOT touched
> by the endpoint — clients arrange a default.

Resolution: `sessionKey → topic` via `getTopicBySessionKey`. The endpoint owns
the security checks currently embedded in the detect functions:
- topic exists / not archived (switch),
- project path validity. Because these endpoints are **explicit local actions**
  (invoked by a tool the model called, not parsed from free text), they use
  `trustRawPaths:true` — same trust level as the `/project` slash command and
  the adopt endpoint. The `isKnownProject` gate (which existed only to defend the
  untyped marker channel) is **not** needed here.

The detect functions in `topics.ts` are refactored so their *core* logic moves
into helpers the endpoints call; the *marker-parsing wrappers* are deleted.

### Layer 2 — Provider tool surfaces
Tools are how the model reaches Layer 1. Coverage differs by provider tier
(this is the crux; see matrix).

**CLI providers (claude-code, codex) — via MCP bridge.**
Add to `server/mcp/topics-mcp-server.ts`:
- `TOOLS` entries (name + description + inputSchema) for `bind_project`,
  `create_project`, `switch_topic`, `create_topic`.
- `TOOL_HANDLERS` entries that `httpJson(...)` to the Layer-1 endpoints, exactly
  like `open_browser_pane` → `callOpenBrowserPane`. The bridge already carries
  `sessionKey` in `ParsedArgs`, so the handler hits
  `/api/sessions/:sessionKey/...`.
- codex: confirm it loads the same `--mcp-config`; if not, it falls back to the
  user-driven path (documented), since codex is not a primary control surface.

**SDK providers (claude, openai) — via `tools` passthrough.**
- Define the control tools as Anthropic `Tool[]` (mirror `server/browser-tools.ts`).
- In `chat.ts`, where `sendOptions.tools = browserTools` is set for passthrough
  providers, append the control tools.
- Dispatch in the existing `handler.onToolStart` switch (mirror
  `dispatchBrowserToolCall`): on a control tool, call the Layer-1 endpoint,
  then synthesize a short tool-result confirmation. Single-turn is fine — no
  result is needed back in-turn for a fire-and-forget side-effect.

**Gateway provider (openclaw).**
- Tools are gateway-owned. Decision gate before implementing:
  - if the gateway exposes equivalent control tools → map handler events to
    Layer-1 endpoints;
  - else → openclaw keeps NO AI-initiated control; log a one-line warning at
    assembly time and rely on user-driven UI. Must not crash or silently no-op
    in a way that looks like success.

### Layer 3 — Instruction / context
`server/context/assemble.ts`:
- **Delete** `pushProjectMarkersBlock` / `projectMarkersContent`,
  `topicSwitchContent` (marker variant), and the marker branch of
  `browserInstructionContent`.
- For providers WITH a tool surface, tool descriptions carry the "when to use"
  guidance (the MCP/`Tool[]` `description` fields) — no system-prompt block
  needed. Keep at most a thin block only if a provider needs nudging.
- The existing claude-code branch that already steers to `open_browser_pane`
  becomes the template for all four new tools.

### Layer 4 — Sanitization (legacy guard, downgraded)
- **Keep** `server/lib/markers.ts` `stripMarkers()` + `CLOSED_MARKER_REGEX` and
  apply it ONLY on the read/replay/display paths (`build-provider-history.ts`,
  client `useChat.ts`, claude-code replay) so stored history with old markers
  never leaks. 
- **Remove** the *live* per-delta marker detection/dispatch in `chat.ts` and
  `stream-markers.ts`'s coupling to side-effects (it may still strip for display
  of legacy content).
- Net: markers are no longer a control channel, only a historical artifact that
  is defensively scrubbed.

## Provider capability matrix (decision-relevant)

| Provider | Tool channel | Multi-turn | Control after change |
|---|---|---|---|
| claude-code | MCP bridge (`--mcp-config`) | ✓ | AI-initiated via MCP tools |
| codex | CLI (verify MCP) | ✓ | AI-initiated if MCP loads, else user-driven |
| claude (SDK) | `tools` passthrough | ✗ (single-turn) | AI-initiated, fire-and-forget |
| openai (SDK) | `tools` passthrough | ✗ (single-turn) | AI-initiated, fire-and-forget |
| openclaw | gateway-owned | ✓ | gateway tools OR user-driven (decision gate) |

User-driven control (sidebar drag / context-menu / `/project` / `/api/open-project`)
remains available on **all** providers as the universal floor.

## Migration / rollout
1. Land Layer-1 endpoints + tests (no behavior change yet; markers still live).
2. Add MCP tools + SDK passthrough tools; switch `assemble.ts` to instruct via
   tools. Markers still live as belt-and-suspenders.
3. Flip: remove marker instruction blocks + live detection. Keep `stripMarkers`
   as read guard.
4. Confirm openclaw decision; wire or document degradation.
5. Delete now-dead marker code/tests; keep legacy-strip tests.

Each step is independently shippable and reversible; markers are only removed in
step 3 once tools are proven.

## Alternatives considered
- **Structured out-of-band event in the stream** (not text, not a tool): less
  work than tools, but reinvents a private protocol per provider and keeps the
  "app parses model output" coupling. Rejected — tools are the standard.
- **User-driven only (no AI-initiated control):** simplest/most stable, but loses
  auto-nesting when the AI starts working in a repo. Kept as the fallback floor,
  not the primary mechanism.

## Open questions
1. **openclaw gateway**: does it already expose control-style tools we can map,
   or do we accept user-driven-only for that provider?
2. **codex**: does it load the topics MCP config like claude-code?
3. Do we want a thin confirmation surfaced to the user when an AI-initiated
   control action runs (toast), now that it is an explicit tool call rather than
   an invisible marker?
