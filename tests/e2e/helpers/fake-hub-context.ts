/**
 * The agents' context and the feature map of the fake usage hub, for
 * context-features.spec.ts (HUBBR-17, HUBBR-18), in the shapes of the real
 * hub's `/api/contesto`, `/api/context/text`, `/api/contesto/check` and
 * `/api/features` (~/.claude/jarvis/tools/usage-hub/src/context.mjs and
 * features.mjs), trimmed. Placeholder files and projects; the systems of the
 * map are public products, as in the real map.
 */

const DAY = 86_400_000;

export interface FakeContextCheck {
  at: number | null;
  running: boolean;
  /** When the running check began (ms), as the hub writes it. */
  startedAt?: number;
  items: Array<{ a: { file: string; text: string }; b: { file: string; text: string }; why: string }>;
}

/** No check has ever answered: the level says so and offers the first one. */
export function defaultContextCheck(): FakeContextCheck {
  return { at: null, running: false, items: [] };
}

/** What the agent «finds» when the fake check ends. */
export const FOUND_CONTRADICTION = {
  a: { file: "~/.claude/CLAUDE.md", text: "Codice in inglese, commenti in italiano: i nomi di funzioni, tipi e file restano in inglese, i commenti si scrivono in italiano, salvo i termini di dominio." },
  b: { file: "~/.openclaw/workspace-studio-x/AGENTS.md", text: "Code comments in English only: the gate check:comment-language fails on any Italian comment in a new file." },
  why: "Una chiede i commenti in italiano, l'altra in inglese.",
};

const TEXTS: Record<string, string> = {
  "~/.claude/CLAUDE.md": "## Identity\n- Lingua: italiano di default\n- Stile: diretto, conciso.\n\n## Regole globali\n- Una domanda è una domanda.\n- Codice in inglese, commenti in italiano.\n",
  "~/.claude/tools.md": "# TOOLS\n- Email: gws-mail\n- Browser: headless, chiuso a fine lavoro\n",
};

/** agents-doctor as the hub sends it once done: 27 checks, all green. */
export function defaultContextDoctor(): Record<string, unknown> {
  return { ok: true, checks: Array.from({ length: 27 }, (_, i) => ({ ok: true, text: `controllo ${i + 1}` })), error: null };
}

/** Days since each placeholder file changed; the style file is three months old. */
const AGE: Record<string, number> = { style: 90, "agents-md": 0 };

export function contextModel(now: number, check: FakeContextCheck, doctor: Record<string, unknown> = defaultContextDoctor()): Record<string, unknown> {
  const file = (id: string, label: string, path: string, group: string, loaders: string[], tokens: number, note = "", includedBy: string | null = null) =>
    ({ id, label, path, group, loaders, bytes: tokens * 4, chars: tokens * 4, tokens, mtime: now - (AGE[id] ?? 1) * DAY - 60_000, note, includedBy, generatedFrom: null });
  return {
    at: now - 60_000,
    files: [
      file("claude-md", "CLAUDE.md globale", "~/.claude/CLAUDE.md", "Claude Code", ["Claude Code", "OpenClaw (via claude-cli)"], 4443),
      file("inc:tools.md", "TOOLS.md", "~/.claude/tools.md", "Claude Code", ["Claude Code", "OpenClaw (via claude-cli)"], 6282, "incluso da CLAUDE.md", "claude-md"),
      file("agents-md", "AGENTS.md dell'hub", "~/.agents/AGENTS.md", "Codex e jcode", ["Codex", "jcode"], 13110, "generato da CLAUDE.md e inclusioni"),
      file("memory-index", "Indice della memoria", "~/.claude/memory/MEMORY.md", "Claude Code", ["Claude Code (sessioni nate in ~)"], 4907),
      file("style", "Stile di output", "~/.claude/output-styles/kind.md", "Claude Code", ["Claude Code"], 1946),
    ],
    subagentPrompts: [
      file("subagent:oracle.md", "Prompt del sottoagente oracle", "~/.claude/agents/oracle.md", "Prompt dei sottoagenti", [], 439),
      file("subagent:verifier.md", "Prompt del sottoagente verifier", "~/.claude/agents/verifier.md", "Prompt dei sottoagenti", [], 512),
    ],
    otherSources: [
      file("project:acme-web", "CLAUDE.md · acme-web", "~/Projects/acme-web/CLAUDE.md", "CLAUDE.md dei progetti", [], 302, "letto nelle sessioni di quel progetto"),
      file("ops", "Memoria operativa", "~/.openclaw/OPS.md", "Memoria operativa di OpenClaw", [], 7035, "letto su richiesta"),
    ],
    skills: { count: 41, tokens: 1780, loaders: ["Claude Code", "Codex", "jcode", "OpenClaw"], items: [{ name: "senior-pass", tokens: 61 }, { name: "commit", tokens: 22 }, { name: "graphify", tokens: 74 }] },
    duplicates: [
      { text: "Mai inviare email senza conferma esplicita dell'utente, nemmeno in bozza.", files: ["claude-md", "project:acme-web"] },
    ],
    oldRules: [
      { file: "project:acme-web", line: 212, text: "**Ultimo aggiornamento**: 29 ottobre 2025", date: "2025-10-29", days: 372 },
      { file: "memory-index", line: 77, text: "- [Sessione bloccata su exec](reference_exec_stall.md): risposta persa, causa non provata (maggio)", date: "2026-05-01", days: 188 },
      { file: "ops", line: 40, text: "Il router gira su :3340 fino al trasloco sull'hub: chi lo chiama deve passare dalla porta nuova prima del 18 ottobre, poi la vecchia si spegne", date: "2026-08-02", days: 95 },
      { file: "claude-md", line: 12, text: "Nuovo stile dal 12 settembre", date: "2026-09-12", days: 54 },
    ],
    doctor,
    totals: { byLoader: { "Claude Code": 14888, "OpenClaw (via claude-cli)": 11162, Codex: 14890, jcode: 14890, "Claude Code (sessioni nate in ~)": 4907 } },
    contradictions: { at: check.at, items: check.items, running: check.running, startedAt: check.startedAt },
  };
}

export function contextText(path: string): Record<string, unknown> | null {
  const text = TEXTS[path];
  return text === undefined ? null : { path, text, bytes: text.length, mtime: Date.now() - DAY };
}

// ── The feature map: 16 systems, 172 features, 47 where Jarvis is behind ────

const SYSTEMS = [
  ["jarvis", "Jarvis (jarvis-channels)"], ["openclaw", "OpenClaw"], ["hermes", "Hermes"], ["claude", "Claude Code"],
  ["codex", "Codex"], ["goose", "Goose"], ["openhands", "OpenHands"], ["letta", "Letta"], ["crewai", "CrewAI"],
  ["langgraph", "LangGraph"], ["ag2", "AG2"], ["manus", "Manus"], ["devin", "Devin"], ["cursor", "Cursor"], ["n8n", "n8n"], ["agno", "Agno"],
] as const;

const AREAS: Array<{ id: string; name: string; groups: Array<[id: string, name: string, leaves: Array<[id: string, name: string, desc: string]>]> }> = [
  { id: "channels", name: "Channels and messaging", groups: [
    ["ch.chat", "Chat platforms", [["ch.wa", "WhatsApp", "Native WhatsApp bridge (DM+groups)"], ["ch.dc", "Discord", "Discord bot with threads/DM"], ["ch.tg", "Telegram", "Telegram bot"], ["ch.sl", "Slack / Teams", "Workspace chat as agent surface"], ["ch.imsg", "iMessage / Signal / SMS", "Other consumer messengers"], ["ch.count", "20+ channels from one gateway", "Single process serves many channels"]]],
    ["ch.sem", "Channel semantics", [["ch.group", "Group chat handling", "Mention gating, per-group policy, participant-aware"], ["ch.pair", "DM pairing / allowlist", "Unknown senders must be approved before talking to the agent"], ["ch.thread", "Threads / per-chat sessions", "Session keyed per chat/thread with isolation"], ["ch.stream", "Streaming / edits / typing indicators", "Live-edit replies, typing, reactions"], ["ch.xplat", "Cross-platform continuity", "Same conversation continues across channels"], ["ch.outbox", "Durable outbound queue", "Outgoing messages queued, retried, deduped"]]],
    ["ch.remote", "Remote control and apps", [["ch.rc", "Remote control of local session", "Drive local agent from phone/web"], ["ch.app", "Native companion apps", "macOS/iOS/Android apps incl. voice, camera, canvas"], ["ch.api", "HTTP/WebSocket/ACP API for clients", "Programmatic access to sessions"], ["ch.email", "Email as channel", "Inbound/outbound mail triage"], ["ch.voicecall", "Phone call channel", "Voice calls in/out"]]],
  ] },
  { id: "engine", name: "Engine and runtime", groups: [
    ["en.loop", "Agent loop", [["en.model", "Multi-provider models", "Switch provider/model without code changes"], ["en.harness", "Pluggable harness (Claude/Codex/local)", "Agent engine is swappable plugin"], ["en.sdk", "Embeddable SDK", "Library to build custom agents on the same loop"], ["en.headless", "Headless / non-interactive mode", "Run unattended with structured output"], ["en.stream", "Streaming events / structured output", "Typed event stream, JSON schema output"], ["en.plan", "Plan mode / approval of plan", "Read-only plan then execute"], ["en.interrupt", "Interrupt and redirect mid-turn", "Steer a running turn"]]],
    ["en.lang", "Implementation", [["en.rust", "Native compiled core", "Rust/Go binary, small footprint"], ["en.lsp", "Code intelligence (LSP / repo map)", "Language-server or AST awareness"], ["en.browser", "Built-in browser use", "Headless/real browser control"], ["en.computer", "Computer use (desktop)", "Screenshot+mouse/keyboard control"]]],
    ["en.managed", "Managed / hosted runtime", [["en.cloud", "Cloud agent sessions", "Agent runs in vendor cloud sandbox"], ["en.managed", "Managed agents API", "Server-hosted agents with managed sandbox"], ["en.worktree", "Git worktree isolation per task", "Parallel tasks in separate worktrees"], ["en.pr", "PR / code-review automation", "Opens PRs, reviews, responds to comments"]]],
  ] },
  { id: "tools", name: "Tools and extensibility", groups: [
    ["tl.mcp", "MCP", [["tl.mcpc", "MCP client", "Consumes MCP servers"], ["tl.mcps", "Exposes itself as MCP server", "Other agents can call it"], ["tl.gw", "MCP gateway with hot mount/unmount", "Mount child servers on demand"], ["tl.oauth", "MCP OAuth / remote servers", "Streamable HTTP + OAuth"], ["tl.reg", "Connector registry / marketplace", "Discover and install tools"]]],
    ["tl.dyn", "Dynamic loading and discovery", [["tl.search", "Tool search (deferred schemas)", "Load tool schemas on demand to save context"], ["tl.cm", "Code mode (agent writes code that calls tools)", "Tools called from generated scripts, not one by one"], ["tl.plug", "Plugin system", "Installable bundles of tools/skills/hooks"], ["tl.forge", "Agent creates its own tools", "Drafts new tools from repeated manual work"], ["tl.perm", "Per-agent tool allow/deny lists", "Restrict which tools each agent sees"]]],
    ["tl.builtin", "Built-in tools", [["tl.shell", "Shell / file edit", "Bash and file tools"], ["tl.web", "Web search and fetch", "Search + page fetch"], ["tl.cli", "CLI tools as first-class", "Agent drives local CLIs rather than MCP"], ["tl.hooks", "Lifecycle hooks", "Pre/post tool-use hooks to block or rewrite"], ["tl.ask", "Ask-user question tool", "Structured multiple-choice questions"]]],
  ] },
  { id: "memory", name: "Memory", groups: [
    ["mem.short", "Short-term / context", [["mem.sess", "Persistent sessions", "Resume past conversations"], ["mem.fork", "Session fork / branch", "Fork a conversation"], ["mem.rewind", "Checkpoints / rewind", "Undo code and conversation to a point"]]],
    ["mem.long", "Long-term memory", [["mem.files", "Memory as plain files", "Markdown memory the agent reads/writes"], ["mem.curate", "Agent-curated memory with nudges", "Agent periodically decides what to persist"], ["mem.sem", "Semantic / vector search", "Embedding retrieval over memory"], ["mem.fts", "Full-text session search", "Search past transcripts (FTS/BM25)"], ["mem.user", "User modeling", "Deepening model of the user (Honcho etc.)"], ["mem.proj", "Per-project instruction files", "CLAUDE.md / AGENTS.md style"]]],
    ["mem.self", "Self-editing / stateful agents", [["mem.blocks", "Memory blocks edited by agent", "MemGPT-style core memory"], ["mem.sleep", "Background consolidation ('sleep-time')", "Offline memory reorganisation"], ["mem.graph", "Knowledge graph memory", "Entity/relation memory"], ["mem.shared", "Shared memory across agents", "Multiple agents read/write one store"]]],
  ] },
  { id: "sched", name: "Scheduling, automation, proactivity", groups: [
    ["sc.cron", "Scheduled jobs", [["sc.cron", "Cron / interval jobs", "Agent runs on schedule"], ["sc.nl", "Natural-language schedule creation", "Create jobs by chatting"], ["sc.deliver", "Deliver results to any channel", "Cron output to chat platform"], ["sc.loop", "Self-paced loop / wakeup", "Agent re-schedules itself"]]],
    ["sc.trig", "Event triggers", [["sc.web", "Webhooks / API triggers", "External event starts a run"], ["sc.gh", "GitHub/Slack/Linear triggers", "Run on issue/PR/mention"], ["sc.watch", "Background monitors", "Watch process/file/log and wake agent"], ["sc.heart", "Heartbeat / proactive check-in", "Agent checks in without prompt"]]],
    ["sc.work", "Workflows", [["sc.wf", "Declarative workflows / DAGs", "Graph or script of steps"], ["sc.queue", "Task board / queue", "Kanban or queue the agent works from"], ["sc.night", "Overnight batch queue with placement", "Run heavy work off-hours on best host"], ["sc.hitl", "Human-in-the-loop pause/resume", "Interrupt for approval then continue"]]],
  ] },
  { id: "multi", name: "Multi-agent, teams, delegation", groups: [
    ["ma.sub", "Subagents", [["ma.spawn", "Spawn subagent with own context", "Isolated child for a subtask"], ["ma.bg", "Background / parallel subagents", "Run many concurrently"], ["ma.model", "Per-subagent model and effort", "Cheaper model for mechanical work"], ["ma.route", "Auto-routing of tasks to cheapest capable engine", "Decider picks free/cheap/premium backend"], ["ma.defs", "Declarative subagent definitions", "Agents as files with prompt+tools"]]],
    ["ma.team", "Agent teams", [["ma.lead", "Lead + teammates with shared task list", "Team members coordinate via shared tasks"], ["ma.msg", "Inter-agent messaging", "Agents message each other"], ["ma.role", "Role-based crews", "Roles/goals/backstory abstraction"], ["ma.graph", "Graph orchestration of agents", "Explicit state machine between agents"], ["ma.handoff", "Handoffs / swarm pattern", "Transfer control between agents"], ["ma.debate", "Group chat / debate patterns", "Multi-agent conversation managers"], ["ma.display", "Teammate panes (tmux/iTerm) UI", "Watch/steer each teammate"]]],
    ["ma.xagent", "Cross-agent interop", [["ma.a2a", "A2A / ACP protocol", "Standard agent-to-agent protocol"], ["ma.term", "Drive other agents' terminals", "Read/send to other running agent sessions"], ["ma.verify", "Verifier on different model than writer", "Independent checking"]]],
  ] },
  { id: "safety", name: "Safety, permissions, sandboxing", groups: [
    ["sf.perm", "Permissions", [["sf.modes", "Permission modes (ask/auto/bypass)", "Tiered approval of actions"], ["sf.rules", "Allow/deny rules per command", "Pattern rules"], ["sf.auto", "Classifier-based auto approval", "Model decides if action is safe"], ["sf.appr", "Approvals routed to chat", "Approve risky action from phone"]]],
    ["sf.sand", "Sandboxing", [["sf.os", "OS-level sandbox (seatbelt/bwrap)", "Filesystem/network isolation of shell"], ["sf.docker", "Container/remote backends", "Docker, SSH, Modal, Daytona"], ["sf.sig", "Signal cage for subagents", "Prevent kill/pkill from agent shells"], ["sf.net", "Network egress allowlist", "Limit outbound domains"]]],
    ["sf.group", "Group and sender safety", [["sf.wall", "Group walls (tools denied in multi-sender chats)", "Owner-only tools stripped in groups"], ["sf.owner", "Owner/trust levels per sender", "Different trust per identity"], ["sf.inj", "Prompt-injection defences", "Untrusted content boundary rules"], ["sf.secret", "Secrets in keychain/vault", "No plaintext credentials"], ["sf.audit", "Security audit command", "Self-check of exposure"], ["sf.guard", "Push/privacy guards", "Block leaking personal data on publish"]]],
  ] },
  { id: "reliab", name: "Reliability", groups: [
    ["rl.dur", "Durability", [["rl.outbox", "Durable outbox", "Messages survive crashes"], ["rl.dur", "Durable execution / checkpointed state", "Resume graph/run after crash"], ["rl.resume", "Resume session after restart", "Reopen with full context"], ["rl.idem", "Idempotent sends / dedupe", "No double messages"]]],
    ["rl.fail", "Failure handling", [["rl.retry", "Model retries and fallback chain", "Retry and failover between providers"], ["rl.dead", "Dead-letter queue and resubmit", "Failed inbound messages recoverable"], ["rl.stuck", "Stuck-session watchdog", "Detects and unsticks hung sessions"], ["rl.mem", "Memory watchdog / restart policy", "Auto-restart on leak"], ["rl.limit", "Rate-limit / quota awareness", "Pace by subscription quota"]]],
    ["rl.ver", "Verification", [["rl.evid", "Completion needs proof", "Done requires command/measure"], ["rl.eval", "Built-in eval / benchmarks", "Eval harness"], ["rl.test", "Self-test of the agent system", "Doctor / selftest command"]]],
  ] },
  { id: "obs", name: "Observability, UI, dashboard", groups: [
    ["ob.ui", "User interfaces", [["ob.tui", "Terminal UI", "Interactive TUI"], ["ob.web", "Web control UI", "Browser dashboard for sessions"], ["ob.desk", "Desktop app", "Native app"], ["ob.mobile", "Mobile access", "Phone UI/notifications"], ["ob.board", "Kanban board of agent tasks", "Cards for tasks with review state"]]],
    ["ob.tel", "Telemetry and tracing", [["ob.otel", "OpenTelemetry export", "Traces/metrics via OTel"], ["ob.trace", "Run tracing UI (LangSmith, etc.)", "Visual trace of steps"], ["ob.usage", "Usage/cost dashboard", "Tokens and spend per session"], ["ob.auto", "Automation outcome registry with feedback", "Every automation tracked, human verdict logged"], ["ob.health", "System health reports", "Mac/host health summaries"], ["ob.status", "Progress pings for long jobs", "Telegraphic status at fixed intervals"]]],
  ] },
  { id: "cost", name: "Cost and context efficiency", groups: [
    ["co.ctx", "Context management", [["co.cache", "Prompt caching", "Reuse provider cache"], ["co.compact", "Auto-compaction", "Summarise old context"], ["co.clear", "Context editing / tool-result clearing", "Drop stale tool outputs"], ["co.deferred", "Deferred tool schemas", "Defer MCP schemas to save tokens"], ["co.subctx", "Subagent context isolation", "Child work doesn't pollute parent"], ["co.zero", "Zero-context-cost script turns", "Pipelines collapsed into one script"]]],
    ["co.cost", "Spend control", [["co.cheap", "Route mechanical work to cheap/free models", "Cost-aware routing"], ["co.budget", "Budget caps", "Max spend/turns per run"], ["co.local", "Local model support", "Ollama/vLLM etc."], ["co.sub", "Use consumer subscriptions as backend", "Claude/ChatGPT plan as engine"], ["co.pace", "Quota pacing across accounts", "Switch accounts by remaining quota"]]],
  ] },
  { id: "media", name: "Media", groups: [
    ["md.voice", "Voice", [["md.stt", "Speech-to-text of voice notes", "Transcribe inbound audio"], ["md.tts", "Text-to-speech replies", "Spoken output"], ["md.live", "Realtime voice conversation", "Live full-duplex voice"]]],
    ["md.vis", "Images and video", [["md.imgin", "Image understanding", "Vision inputs"], ["md.imggen", "Image generation tool", "Create images"], ["md.video", "Video understanding", "Analyse video"], ["md.vidgen", "Video generation", "Create video"], ["md.doc", "PDF/Office documents", "Read/produce docs"], ["md.canvas", "Canvas / live artifacts", "Agent-rendered pages the user can open"]]],
  ] },
  { id: "improve", name: "Self-improvement and skills", groups: [
    ["im.skill", "Skills", [["im.skills", "SKILL.md skills", "Progressive-disclosure skill folders"], ["im.auto", "Autonomous skill creation", "Agent writes skills after complex tasks"], ["im.refine", "Skills self-improve in use", "Edit skills from experience"], ["im.mkt", "Skill marketplace", "Public registry (ClawHub etc.)"], ["im.scan", "Skill security scanning", "Scan third-party skills"]]],
    ["im.learn", "Learning loops", [["im.rule", "Corrections become rules", "Repeated feedback promoted to rules"], ["im.traj", "Trajectory export for training", "Batch trajectories for RL"], ["im.anti", "Anticipation of next request", "Predict user's next asks"], ["im.forge", "Tool forge from repeated work", "Draft tools for repetitive flows"]]],
  ] },
  { id: "update", name: "Updates and maintenance", groups: [
    ["up.upd", "Updating", [["up.self", "Self-update command", "One-command update"], ["up.safe", "Update with rollback", "Stop, update, verify, roll back on failure"], ["up.chan", "Release channels (stable/beta)", "Beta/canary tracks"], ["up.feed", "Machine-readable release feed", "GitHub releases atom/API"], ["up.migr", "Config migration tooling", "Migrate from other agents"]]],
    ["up.ops", "Maintenance", [["up.doc", "Doctor / diagnostics", "Health check CLI"], ["up.backup", "Backups", "Encrypted automatic backups"], ["up.clean", "Nightly cleanup/consolidation", "Memory and file hygiene jobs"], ["up.repo", "Config as versioned repo", "Config tracked in git, encrypted secrets"]]],
  ] },
  { id: "deploy", name: "Deployment and footprint", groups: [
    ["dp.where", "Where it runs", [["dp.local", "Local machine", "Runs on laptop"], ["dp.vps", "Cheap VPS / serverless idle", "Low idle cost deployment"], ["dp.docker", "Docker / Nix packaging", "Container images"], ["dp.multi", "Multi-host (Mac + PC offload)", "Heavy work offloaded to other host"], ["dp.win", "Native Windows", "Windows without WSL"], ["dp.mob", "Termux / mobile host", "Run on phone"]]],
    ["dp.foot", "Footprint", [["dp.mem", "Low idle memory", "Small resident footprint"], ["dp.lazy", "On-demand daemons (launchd sockets)", "Spin up on first request, exit idle"], ["dp.team", "Multi-user team deployment", "One gateway for many users"], ["dp.found", "Open source licence", "OSS code"]]],
  ] },
];

const WEIGHT: Record<string, number> = { yes: 1, partial: 0.5, no: 0 };

/** The decision on a feature: the first two still to build, then a spread of the others. */
function planOf(i: number, behind: boolean): Record<string, unknown> | undefined {
  if (i === 0) return { kind: "scelta", why: "Nessun cliente lo usa: si fa quando serve" };
  if (i === 1) return { kind: "sviluppo", prio: 1, why: "Serve al secondo canale" };
  if (i === 2) return { kind: "sviluppo", prio: 2, why: "Dopo il primo" };
  if (behind && i % 2 === 0) return { kind: "scelta", why: "Si fa quando serve" };
  if (i % 5 === 1) return { kind: "altro", why: "Lo copre un altro strumento" };
  if (i % 7 === 3) return { kind: "topics", why: "Si usa da Topics" };
  if (i % 11 === 4) return { kind: "fatto", why: "Fatto il 03/11" };
  return undefined;
}

/** The first feature has more news than the view shows: ten, the first from OpenClaw. */
function newsOf(i: number, id: string, name: string, now: number): Array<Record<string, unknown>> {
  if (i % 4 !== 0) return [];
  const n = i === 0 ? 10 : 1;
  return Array.from({ length: n }, (_, k) => ({
    system: i % 8 === 0 && k === 0 ? "openclaw" : "example/agents",
    title: `fix(${id}): keep the queue when the gateway restarts (#${1000 + i + k})`,
    url: `https://example.com/news/${i}-${k}`,
    date: new Date(now - ((i + k) % 9) * DAY).toISOString(),
    match: name.toLowerCase(),
  }));
}

/**
 * The pyramid of what Jarvis needs: seven levels, 19 placeholder functions,
 * 15 of the 17 needed covered, 1 done today, 1 moving to the single engine,
 * 1 missing, 2 let go or withdrawn.
 */
export function pyramidMap(now: number): Record<string, unknown> {
  const ok = (name: string, where: string, use = "\u2014") => ({ name, where, note: "s\u00ec", use, status: "ok" });
  return {
    updated: new Date(now - 3 * DAY).toISOString().slice(0, 10),
    title: "Piramide di ci\u00f2 che serve a Jarvis",
    levels: [
      { n: 1, name: "Canali", desc: "Da dove arrivano i messaggi e come si risponde", items: [
        ok("Chat dal telefono, un account", "src/channels/phone.rs", "36 turni"),
        { name: "Bot di squadra", where: "src/channels/team.rs", note: "parziale", use: "12", status: "fatto", outcome: "fatta, anche sul secondo canale" },
        { name: "Ponte della posta", where: "plugin mail-bridge", note: "parziale", use: "?", status: "motore", outcome: "va nel motore unico" },
        { name: "Canale vecchio", where: "config legacy", note: "no", use: "\u2014", status: "lascia", outcome: "non serve" },
      ] },
      { n: 2, name: "Motore", desc: "Chi esegue il turno", items: [ok("Turno con riserva", "src/engine/turn.rs"), ok("Coda dei turni", "src/engine/queue.rs")] },
      { n: 3, name: "Strumenti", desc: "Cosa pu\u00f2 fare l'agente", items: [ok("Shell", "tools/shell"), ok("Ricerca", "tools/search"), { name: "Invio verso altre chat", where: "tools/send", note: "no", use: "?", status: "no" }] },
      { n: 4, name: "Conoscenza", desc: "Cosa sa e ricorda", items: [ok("Schede", "memory/"), ok("Richiamo", "memory/recall")] },
      { n: 5, name: "Automazioni", desc: "Cosa gira da solo", items: [ok("Cron", "cron/"), ok("Brief", "cron/brief"), { name: "Job vecchio", where: "cron/old", note: "no", use: "0", status: "ritira" }] },
      { n: 6, name: "Viste", desc: "Cosa vedi tu", items: [ok("Pannello", "public/"), ok("Board", "board/"), { name: "Avvisi", where: "notify/", note: "s\u00ec", use: "\u2014", status: "altro", outcome: "dalla campanella" }] },
      { n: 7, name: "Sicurezza", desc: "Chi pu\u00f2 fare cosa", items: [ok("Muri dei gruppi", "guard/groups"), ok("Segreti nel portachiavi", "guard/keychain")] },
    ],
  };
}

/** The map, built so the totals are the real map's (172 features, 47 behind). */
export function featuresMap(now: number): Record<string, unknown> {
  const total = AREAS.reduce((n, a) => n + a.groups.reduce((m, [, , leaves]) => m + leaves.length, 0), 0);
  let index = 0;
  const others = SYSTEMS.slice(1).map(([id]) => id);
  const score = (leaves: Array<{ status: Record<string, string> }>, id: string) => {
    let known = 0, got = 0;
    for (const l of leaves) { const w = WEIGHT[l.status[id] ?? ""]; if (w === undefined) continue; known++; got += w; }
    return { pct: known ? Math.round((100 * got) / known) : null, known };
  };
  const rank = (leaves: Array<{ status: Record<string, string> }>) => SYSTEMS.map(([id]) => ({ id, ...score(leaves, id) }))
    .filter((r) => r.pct !== null).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  const areas = AREAS.map((a) => {
    const children = a.groups.map(([gid, gname, leaves]) => {
      const kids = leaves.map(([id, name, desc]) => {
        const i = index++;
        // A permutation of 0..171: exactly 47 land below 47.
        const behind = (i * 7) % total < 47;
        const status: Record<string, string> = {};
        // Not behind: Jarvis has it, or has it in part where at most two others do.
        const ourPart = !behind && i % 5 === 0;
        others.forEach((id, j) => {
          const k = (i * 3 + j * 5) % 7;
          status[id] = behind ? (j < 4 || k < 3 ? "yes" : k < 5 ? "partial" : "no")
            : ourPart ? (j < 2 ? "yes" : k < 3 ? "partial" : "no")
              : (k < 2 ? "yes" : k < 4 ? "partial" : "no");
        });
        status.jarvis = behind ? (i % 3 === 0 ? "partial" : "no") : ourPart ? "partial" : "yes";
        const have = others.filter((id) => status[id] === "yes").length;
        const ours = status.jarvis!;
        // The watcher quotes upstream changelogs as written: commit titles, in English.
        const news = newsOf(i, id, name, now);
        const plan = planOf(i, behind);
        const note = i === 0 ? "solo i messaggi diretti e i gruppi del primo account" : undefined;
        const sources = i === 0 ? ["https://docs.example.com/channels/whatsapp"] : [];
        return { id, name, desc, status, sources, keywords: [name.toLowerCase()], ours, have, of: others.length, behind: ours !== "yes" && have >= 3, news, ...(plan ? { plan } : {}), ...(note ? { note } : {}) };
      });
      return { id: gid, name: gname, children: kids, ranking: rank(kids) };
    });
    return { id: a.id, name: a.name, children, ranking: rank(children.flatMap((c) => c.children)) };
  });
  const all = areas.flatMap((a) => a.children.flatMap((c) => c.children));
  return {
    meta: { updated: new Date(now - 2 * DAY).toISOString().slice(0, 10), checked: new Date(now).toISOString() },
    systems: SYSTEMS.map(([id, name]) => ({ id, name, version: "own", latest: null })),
    ranking: rank(all),
    totals: { leaves: all.length, behind: all.filter((l) => l.behind).length, withNews: all.filter((l) => l.news.length).length },
    areas,
    pyramid: pyramidMap(now),
  };
}
