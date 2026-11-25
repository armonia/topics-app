## Purpose

Provider setup, model selection, and coding execution must describe the same available service. API chat and native/CLI coding have distinct capabilities.

## Requirements

### Requirement: MP-SETUP-02 — One provider page with separate tool management

Provider AI settings SHALL keep setup, model selection and connection maintenance in the same expandable list. Unconfigured API connections SHALL expand in place; ready connections SHALL expose key replacement on request within their own card. Provider status and the selected model SHALL remain understandable when collapsed. Errors SHALL retain a direct recovery path.

Advanced provider controls SHALL be grouped as agent execution and local programs. MCP and persistent tool grants SHALL live in a separate Tools settings section using the shared navigation and deep-link registry. Opening Providers, including advanced controls, SHALL issue no MCP discovery requests. Opening Tools SHALL load its current state without modifying any settings or grants.

#### Scenario: Connect and manage in place
- **WHEN** a user expands an unconfigured API provider and connects it
- **THEN** its model controls remain open in the same list
- **AND** a ready provider keeps key replacement folded until requested.

#### Scenario: Tools are independent from provider execution
- **WHEN** a user opens provider execution settings and then Tools
- **THEN** MCP is loaded only in Tools and tool grants remain reachable there
- **AND** provider, runtime and permission selections remain unchanged.

### Requirement: MP-SETUP-01 — Discoverable and persistent API connections

Settings SHALL offer OpenAI and Anthropic API setup before provider registration, support replacement of rejected keys, and explain API billing and installation-scoped storage. Keys SHALL be validated before replacing working credentials, persist in a private server file, and never appear in public settings or snapshots. The reserved credentials directory SHALL be excluded from project file reads, preview, media, file listings, and search, including access through symbolic links. Bootstrap and later discovery SHALL use the same canonical state root. Desktop and mobile SHALL retain usable inputs and controls. Advanced runtime tools SHALL mount only when expanded.

#### Scenario: First API connection and replacement
- **WHEN** a user connects an API key and later replaces it
- **THEN** the validated key persists, the provider appears in the picker, and existing turns continue
- **AND** rejected replacements leave the old credentials intact.

### Requirement: MP-API-01 — Explicit selection and current OpenAI requests

OpenAI requests SHALL preserve the selected model and use compatible output limits. Default settings SHALL apply to subsequent requests. The model catalog SHALL exclude incompatible modalities and share diagnostics requests. Late probes and initial HTTP snapshots SHALL not overwrite newer configuration. Stream failures SHALL not be reported as successful completions. An unavailable explicitly selected provider SHALL fail before message persistence, without routing to another provider.

#### Scenario: Selected GPT and a stale provider response
- **WHEN** a GPT model is selected and a prior snapshot arrives late
- **THEN** the chosen provider/model remain unchanged and subsequent requests carry the selected model.

### Requirement: MP-TASK-01 — Coding-capable task models and correct workspace

Task selectors SHALL list models only from ready coding runtimes. API chat-only transports SHALL not execute coding tasks. A selected GPT model SHALL route to Codex with the task worktree as its working directory. Missing coding runtimes SHALL produce an actionable error rather than use an unrelated default. Existing sessions SHALL not migrate automatically when settings change, and controls SHALL not offer task-model changes that dispatch ignores.

#### Scenario: GPT task with an unavailable runtime
- **WHEN** the selected coding runtime is unavailable at dispatch
- **THEN** no API-only or foreign runtime starts the task.

### Requirement: MP-TASK-02 — Stable readiness while provider discovery refreshes

A routine snapshot refresh SHALL retain the last successful readiness and model catalog until its replacement diagnostic completes. A failed replacement diagnostic SHALL revoke readiness. Explicit invalidation, including credential replacement, SHALL discard the previous readiness immediately.

During initial discovery, a task's explicit Codex selection or Codex coding default SHALL wait for Codex instead of falling back to Claude. Pending discovery SHALL be distinguishable from unavailable configuration, and dispatcher retries SHALL preserve the selected provider without consuming an execution attempt.

#### Scenario: A ready provider is being refreshed
- **WHEN** the snapshot cache expires and a new diagnostic is still pending
- **THEN** the previously ready provider remains routable with its prior catalog
- **AND** a subsequent failed diagnostic makes it unavailable for new tasks.

#### Scenario: Codex has not finished its first diagnostic
- **GIVEN** Codex is the selected task provider or coding default and Claude is ready
- **WHEN** Codex is still loading
- **THEN** task routing reports pending Codex discovery without selecting Claude.

### Requirement: MP-AUTH-01 — Bounded native credential renewal

Native OAuth renewal SHALL hold the inter-process lock, honor a bounded network timeout, and re-read credentials after waiting. A failed lock acquisition SHALL not cause a concurrent refresh or removal of another process's lock.

#### Scenario: Another process owns credential renewal
- **WHEN** the lock wait expires
- **THEN** Topics reuses freshly renewed credentials if available or reports unavailability without issuing an unlocked refresh.

### Requirement: MP-DISPATCH-01 — Claude plan limits only hold Claude work

A Claude plan hold SHALL prevent new Claude coding turns and task resumes until the hold expires or is cleared. The approaching-limit threshold SHALL prevent new Claude task starts while preserving the existing policy for already assigned sessions. Neither limit SHALL prevent Codex/GPT tasks from starting or resuming. A held Claude task SHALL not block an eligible Codex task behind it.

The decision SHALL use the same effective provider as task execution: explicit task model, then board model, then the current coding default. Reused or assigned sessions SHALL retain their actual provider. A limit SHALL not switch providers, consume dispatch attempts, create worktrees or topics, or drop pending human updates. Queued tasks SHALL become eligible again when the relevant limit ends.

#### Scenario: Mixed queue during a Claude plan hold
- **GIVEN** a held Claude task ahead of a task explicitly assigned to GPT
- **WHEN** dispatch runs with Codex available
- **THEN** only the GPT task starts, through Codex, and the Claude task remains queued without consuming an attempt.

#### Scenario: A bound session outlives a default change
- **GIVEN** an existing Claude session and a new Codex default
- **WHEN** a Claude hold is active and a human update requests resume
- **THEN** the update waits for Claude without changing the session; an existing Codex session may resume.

### Requirement: MP-TASK-03 — General automatic selection and readable task models

Task creation, task details and board settings SHALL describe Auto as selection among connected, available models compatible with coding tasks, across providers. The task's Auto choice SHALL explain that an explicit project model takes precedence over general Auto. Auto SHALL NOT imply a restriction to one provider or access to API-only coding capabilities. Existing explicit model overrides and the lock on already assigned sessions SHALL remain intact.

When dispatch resolves a model, task details and board cards SHALL retain its recognizable model name and version rather than reducing it to a provider or family name. Long labels SHALL fit their containing surface, with the complete model available in the detail or tooltip.

#### Scenario: General Auto and a resolved GPT model
- **WHEN** a task using Auto is resolved to `gpt-5.5`
- **THEN** the model chip identifies `GPT-5.5`, not only `gpt`
- **AND** the same model label is used in manual selection and task presentation.

#### Scenario: Manual selection and existing sessions
- **WHEN** a user opens the task model selector before assignment
- **THEN** Auto and available explicit models remain selectable
- **AND** an assigned session keeps its model selector locked.

### Requirement: MP-TASK-04 — Execution first, then compatible models

Every AI input SHALL use the same accessible, responsive model selector
(`ModelSelector`, MSEL-01). One panel shows Automatic and the current models of
every ready engine in the server snapshot, grouped by model maker. There is no
intermediate engine step. Each maker group names, in its heading, the engine
that executes its rows, and lets the user switch engine in place when more than
one engine serves the group; a row repeats its engine only when it differs from
the heading, and its accessible name always contains it (amended 2026-10-04: the
row used to carry the engine and the switch).

A row offers only models its engine can actually execute on that surface.
Coding-task surfaces SHALL exclude API chat transports. Topics native SHALL
execute only its supported Claude coding models. GPT coding models SHALL be
executed by Codex. No unavailable engine or model SHALL silently fall back to a
different engine: a direct route taken because Topics routing cannot reach the
target is declared on the row and on the turn (AICTRL-01).

#### Scenario: A coding task chooses a Codex model
- **WHEN** the user picks GPT-6.1-Sol before starting a task
- **THEN** the OpenAI group heading names Codex as its engine, and the row's accessible name contains Codex
- **AND** dispatch persists and runs Codex with that model.

#### Scenario: Normal chat uses the same presentation
- **WHEN** the same control is opened in a normal chat
- **THEN** models from every ready chat provider in the server snapshot are visible together
- **AND** each group heading names the provider that runs its rows, and a row that runs elsewhere names its own.

### Requirement: MP-TASK-05 — Explicit automatic and project-default scopes

General Automatic SHALL consider ready, compatible providers that are not in an
exhausted quota window. A project default SHALL be labelled and stored as a
separate scope, not as Automatic, an account, a model, or a runtime. Automatic
inside an explicitly selected execution engine SHALL remain constrained to that
engine. The concrete resolved model SHALL stay visible after dispatch without
rewriting labels on historical turns.

#### Scenario: Project default and general Automatic differ
- **WHEN** a task has no override and its project has an explicit default
- **THEN** the UI identifies that inherited project default
- **AND** general Automatic remains a separate selectable value.

### Requirement: MP-TASK-06 — Persistence, unavailability and compatibility

Runtime and model choices SHALL survive task creation, editing, dispatch and
resume. Existing model-only values SHALL remain readable and executable under
their legacy routing rules. An explicit stored value that is no longer
available SHALL remain visible with its reason and a Settings action; it SHALL
not be rewritten. Existing effort choices, manual provider/model overrides and
already-running session bindings SHALL remain authoritative.

#### Scenario: A selected runtime becomes unavailable
- **WHEN** the server snapshot reports the explicitly selected runtime as
  unavailable
- **THEN** the control retains the runtime and model with the reported reason
- **AND** dispatch stops with an actionable error instead of switching runtime.

#### Scenario: A saved model leaves a ready catalog
- **WHEN** a saved prefixed or legacy model is absent from its runtime's latest catalog
- **THEN** it remains the selected manual value in a disabled unavailable row
- **AND** the reason and Settings recovery action remain visible without selecting project Auto.

#### Scenario: A task-capable ACP runtime
- **WHEN** an ACP adapter advertises coding-task capability
- **THEN** its compatible models may appear for explicit task selection
- **AND** an ACP adapter without that capability remains chat-only.

#### Scenario: A resumed session is already bound
- **WHEN** a task resumes or reuses an existing session
- **THEN** its provider, model and effort remain unchanged
- **AND** the selector cannot reclassify that historical binding.

### Requirement: MP-TASK-07 — Interaction and localization

The shared control SHALL:
- use existing application tokens and popover primitives;
- provide Italian and English copy;
- support keyboard traversal and selection across every maker section;
- restore focus to its trigger after closing;
- remain within a small viewport as a full-width bottom sheet.

Unavailable choices SHALL expose a reason and recovery action, with sufficient
token-based contrast. The change SHALL add no dependency, and SHALL not promote
the model tier solely to render the UI.

#### Scenario: Keyboard traversal across makers
- **WHEN** the user opens the selector and presses ArrowDown repeatedly
- **THEN** focus moves from the search field through the routing band, Automatic and every model row of every maker, skipping section header labels (a header's engine button is a stop only when it offers a choice)
- **AND** Enter selects the focused row and returns focus to the trigger.

#### Scenario: A selector is disabled
- **WHEN** a surface locks the selector during a write or assigned session
- **THEN** every model, Automatic, engine and recovery action is disabled.

### Requirement: MP-HANDOFF-01 — A fresh CLI session inherits the work, not just the words

When a CLI provider (Claude after a reset, Codex or Muse on a fresh session,
including a chat that just switched provider) starts without native memory of
the chat, the provider SHALL hand it the conversation rebuilt from the store
WITH its tool calls and results, within a token budget (not a turn count).
Pinned context (system messages) SHALL travel whole. Turns cut to fit SHALL be
named, with the Topics tool that reads them back. When the store has nothing
for the session, the provider SHALL fall back to the history the route passed.

#### Scenario: a chat moved to Muse keeps the research
- **GIVEN** a chat whose earlier turns ran tools (searches, page reads)
- **WHEN** its next turn starts a fresh Muse or Codex session
- **THEN** the prompt carries those tool calls and a clipped view of their results

#### Scenario: a long chat is cut by budget and says so
- **GIVEN** a chat whose rebuilt history is larger than the budget
- **WHEN** the handoff is built
- **THEN** it stays within the budget, keeps the opening request and the recent turns, and names how many messages it left out and how to read them

#### Scenario: the handoff fills its own budget, not the native rebuild's
- **GIVEN** a chat whose rebuilt history is larger than the handoff budget
- **WHEN** the handoff is built with the default budget (60k estimated tokens)
- **THEN** the thread SHALL be rebuilt without the native session's rebuild window, and the handoff SHALL come out close to its budget, not at the roughly 44k that window leaves

### Requirement: MP-AGENTAUTH-01 — An agent's bridge authenticates with the daemon token

The routes that let an agent drive Topics (the agents' and the terminals' send and read) SHALL accept the daemon token, re-read from the daemon state on every request so a rotation lands without a restart. The MCP bridge SHALL carry no other token. No test SHALL read the Keychain or the real Topics home.

#### Scenario: The bridge with the daemon token
- **GIVEN** a running server
- **WHEN** an agent's bridge calls a gated route with the daemon token
- **THEN** the route answers, and a wrong daemon token gets 401.

### Requirement: MP-NATENV-01 — A native agent's command runs in the agent's environment, not the server's

The native provider's `bash` tool SHALL spawn its command with the agent environment (`agentBaseEnv`), the same one Claude's Bash and `run_command` get. A secret present in the environment the server was launched with (launchd, `.env`) SHALL NOT reach the command, even though Bun hands a child spawned with no `env` the launch environment.

#### Scenario: The server was launched with a secret in its environment
- **GIVEN** a server launched with `GATEWAY_TOKEN` and `TOPICS_LICENSE_TOKEN` set
- **WHEN** a native agent runs a command that prints them
- **THEN** the command sees neither, and still sees `HOME`.

### Requirement: MP-NATENV-02 — On Windows the agent's environment keeps the CLIs' config folders

The agent environment SHALL carry the Windows system and profile variables (`APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `SystemRoot`, `TEMP` and the like), so a CLI logged in on the machine (`gh`) finds its login. The secret blocklist SHALL still apply.

#### Scenario: gh on the PC node
- **GIVEN** a Windows environment with `APPDATA` and a `GH_TOKEN`
- **WHEN** the agent environment is built from it
- **THEN** `APPDATA` passes and `GH_TOKEN` does not.

### Requirement: QUOTA-SAMPLER-01 — Topics writes the plan quota history itself

The server SHALL append, every few minutes, one line `{t, s: {"claude|<account>|7d": pct}}` to the quota history file the points count reads, so a clean install has a history. The key carries the address of the login read at runtime, so one account is one series. A round SHALL be skipped when the file holds a reading of that series younger than the sampling gap, or when a writer with other keys wrote within the last hour, so a second writer never doubles the points.

#### Scenario: clean folder
- **GIVEN** an empty history folder and two samples with the 7d quota up by 3 points
- **WHEN** the points per hour are counted
- **THEN** they total 3, not null.

#### Scenario: an external writer on the same file
- **GIVEN** another writer appended a Claude 7d reading a moment ago
- **WHEN** the sampler runs
- **THEN** it writes nothing and the points are not doubled.


### Requirement: MP-DIRECT-01 — Configurable OpenAI-compatible chat endpoints

Settings SHALL let a user declare OpenAI-compatible HTTP endpoints with a label, a base URL, an authentication mode of none or bearer, an optional model allow-list and an optional request timeout. Each saved endpoint SHALL register as a chat provider named `direct-<slug>` and SHALL be selectable for chats alongside the built-in providers. Endpoints SHALL persist in a state file written atomically, outside the database and outside any migration. A bearer secret SHALL be stored in a private file of its own, readable only by the account running the server, and SHALL never appear in settings responses, provider snapshots or logs. A malformed or unreadable store SHALL degrade to no configured endpoints without blocking server boot. Deleting an endpoint SHALL remove its provider, its secret and its selection from chats that used it.

Configurable endpoints SHALL NOT appear in the task pickers of the board, whose runtimes must be coding-capable.

#### Scenario: Declare, use and remove an endpoint
- **WHEN** a user adds an endpoint in Settings, tests it, and selects it in a chat
- **THEN** the chat streams from that endpoint and the endpoint survives a server restart
- **AND** after deletion the provider disappears from the chat picker and its secret file entry is gone.

#### Scenario: The board never offers a direct endpoint
- **WHEN** a configured endpoint exists and a task model picker is opened
- **THEN** no `direct-` provider is listed.

### Requirement: MP-DIRECT-02 — Private-network reachability with a guarded URL

Requests to a configured endpoint SHALL be allowed to reach loopback, RFC1918, carrier-grade NAT `100.64.0.0/10` and unique local IPv6 addresses, and SHALL be refused for link-local `169.254.0.0/16`, `fe80::/10`, `0.0.0.0/8` and multicast destinations, for schemes other than http and https, and for URLs carrying user information. The destination SHALL be resolved and re-checked on every request rather than only when saved, and every redirect hop SHALL be checked again before it is followed. A refused destination SHALL surface as a clear endpoint error and SHALL NOT be reported as a model failure.

#### Scenario: Metadata address refused, LAN address allowed
- **WHEN** an endpoint resolves to a cloud metadata address, directly or after a redirect
- **THEN** the request is refused before any body is sent
- **AND** an endpoint resolving to a private or Tailscale address is allowed.

### Requirement: MP-DIRECT-03 — Per-model context window from the endpoint

The provider snapshot SHALL carry a per-model context window for configurable endpoints, taken from the endpoint configuration and from the endpoint's model listing when it reports one. The model picker and the context assembler SHALL prefer that value over the static model table. When an endpoint refuses a request because the context was exceeded, the chat SHALL show a message naming the model and its window rather than the raw upstream error.

#### Scenario: A local 200k model is not shown with the fallback window
- **WHEN** an endpoint reports a context window for its model
- **THEN** the picker badge and the context budget use that window
- **AND** a context-exceeded refusal is shown as a readable explanation.

### Requirement: MP-DIRECT-04 — A configured endpoint is a chat connection, never a task runtime

A configured endpoint SHALL be offered wherever a chat connection is chosen, and SHALL NOT be offered as a task runtime or as a task model, in keeping with MP-TASK-01. It reaches the endpoint in a single round trip, with no file or bash tool and no way to update a task, so a card handed to one could never be closed. A model of a configured endpoint SHALL stay out of the task pickers even when its name resembles a coding model.

#### Scenario: The endpoint is selectable for a chat
- **WHEN** an endpoint is configured and ready
- **THEN** the chat provider picker offers it.

#### Scenario: The same endpoint is absent from the task pickers
- **WHEN** the task runtime and task model options are built from the same snapshot
- **THEN** neither offers the endpoint nor any of its models
- **AND** a provider that really can run tasks is still offered.

### Requirement: MP-DIRECT-05 — A provider name that survives being parsed

The provider name of a configured endpoint SHALL be derived from its identifier with a fixed prefix and SHALL NOT contain a colon, because a task model is stored as `provider:model` and a colon in the provider half would split at the wrong place. A declared context window SHALL be ignored when it is not a positive finite number, so a damaged configuration shows the known-model guess rather than nonsense.

#### Scenario: The name carries no separator
- **WHEN** a provider name is built for an endpoint
- **THEN** it is recognisable as a configured endpoint and contains no colon.

#### Scenario: A damaged declared window is not displayed
- **WHEN** an endpoint declares a window that is zero, negative or not a number
- **THEN** the window shown falls back to the static table instead of the declared value.

### Requirement: MP-NET-01 — One unreachable address of a provider host does not stall Codex

When a provider host resolves to several addresses and the network silently drops one of them, a Codex turn SHALL still reach the host through the others, without the user editing system files or using administrator rights. Topics SHALL start the Codex CLI with HTTPS routed through a loopback-only CONNECT proxy that tries every address of the host, starting the next one after a short attempt delay and at once when an address refuses, and keeps the first that connects. The proxy SHALL accept only clients presenting the per-process secret Topics gave its own children, SHALL offer no plain HTTP forwarding, and SHALL step aside when the user already configured a proxy. When no address answers, the turn SHALL fail with Codex's own error instead of hanging.

#### Scenario: The first address of chatgpt.com is dropped
- **GIVEN** chatgpt.com resolves to a dropped address and a working one
- **WHEN** a Codex turn connects
- **THEN** the connection is made through the working address within one attempt delay.

#### Scenario: A local process without the secret
- **WHEN** a client connects to the proxy without the secret or with a wrong one
- **THEN** it receives 407 and nothing is dialed.

#### Scenario: The user has their own proxy
- **WHEN** HTTPS_PROXY or ALL_PROXY is already set for Topics
- **THEN** Codex is started with the user's proxy and not with Topics' one.
