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
  items: Array<{ a: { file: string; text: string }; b: { file: string; text: string }; why: string }>;
}

/** No check has ever answered: the level says so and offers the first one. */
export function defaultContextCheck(): FakeContextCheck {
  return { at: null, running: false, items: [] };
}

/** What the agent «finds» when the fake check ends. */
export const FOUND_CONTRADICTION = {
  a: { file: "~/.claude/CLAUDE.md", text: "Codice in inglese, commenti in italiano." },
  b: { file: "~/Projects/acme-web/AGENTS.md", text: "Code comments in English only." },
  why: "Una chiede i commenti in italiano, l'altra in inglese.",
};

const TEXTS: Record<string, string> = {
  "~/.claude/CLAUDE.md": "## Identity\n- Lingua: italiano di default\n- Stile: diretto, conciso.\n\n## Regole globali\n- Una domanda è una domanda.\n- Codice in inglese, commenti in italiano.\n",
  "~/.claude/tools.md": "# TOOLS\n- Email: gws-mail\n- Browser: headless, chiuso a fine lavoro\n",
};

export function contextModel(now: number, check: FakeContextCheck): Record<string, unknown> {
  const file = (id: string, label: string, path: string, group: string, loaders: string[], tokens: number, note = "", includedBy: string | null = null) =>
    ({ id, label, path, group, loaders, bytes: tokens * 4, chars: tokens * 4, tokens, mtime: now - DAY, note, includedBy, generatedFrom: null });
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
    skills: { count: 41, tokens: 1780, loaders: ["Claude Code", "Codex", "jcode", "OpenClaw"], items: [] },
    duplicates: [
      { text: "Mai inviare email senza conferma esplicita dell'utente, nemmeno in bozza.", files: ["claude-md", "project:acme-web"] },
    ],
    oldRules: [
      { file: "project:acme-web", line: 212, text: "Ultimo aggiornamento: 29 ottobre 2025", date: "2025-10-29", days: 372 },
      { file: "memory-index", line: 77, text: "Sessione bloccata su exec: risposta persa, causa non provata (maggio)", date: "2026-05-01", days: 188 },
      { file: "ops", line: 40, text: "Il router gira su :3340 fino al trasloco", date: "2026-08-02", days: 95 },
      { file: "claude-md", line: 12, text: "Nuovo stile dal 12 settembre", date: "2026-09-12", days: 54 },
    ],
    doctor: { ok: true, checks: Array.from({ length: 27 }, (_, i) => ({ ok: true, text: `controllo ${i + 1}` })), error: null },
    totals: { byLoader: { "Claude Code": 14888, "OpenClaw (via claude-cli)": 11162, Codex: 14890, jcode: 14890, "Claude Code (sessioni nate in ~)": 4907 } },
    contradictions: { at: check.at, items: check.items, running: check.running },
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

const AREAS: Array<{ id: string; name: string; groups: Array<[string, string[]]> }> = [
  { id: "channels", name: "Channels and messaging", groups: [
    ["Chat platforms", ["WhatsApp", "Telegram", "Discord", "Slack", "Signal", "iMessage", "Matrix", "Microsoft Teams"]],
    ["Voice", ["Voice notes in", "Voice replies out", "Phone calls", "Live transcription", "Wake word", "Speaker diarisation", "Voice cloning"]],
    ["Email", ["Read the inbox", "Draft replies", "Send with confirmation", "Thread summaries", "Attachments", "Calendar invites", "Mail rules"]],
    ["Delivery", ["Reactions", "Typing indicator", "Silent notifications", "Message edits", "Read receipts", "Group mentions", "Retry on failure"]],
  ] },
  { id: "memory", name: "Memory and context", groups: [
    ["Recall", ["Semantic search", "Keyword search", "Recall by date", "Recall by person", "Memory on demand", "Hybrid ranking", "Recall citations"]],
    ["Writing memory", ["Automatic notes", "Notes on request", "Forgetting", "Memory review", "Conflict detection", "Memory export", "Import from other assistants"]],
    ["Context", ["Lazy tool loading", "Context compaction", "Prompt caching", "Per-channel prompts", "Context budget", "Rules from files", "Project rules"]],
    ["Knowledge", ["Document index", "PDF reading", "Web pages", "Code repositories", "Spreadsheets", "Images", "Video frames"]],
  ] },
  { id: "tools", name: "Tools and integrations", groups: [
    ["Protocols", ["MCP client", "MCP server", "OpenAPI tools", "Tool gateway", "Remote MCP", "Tool permissions", "Tool sandbox"]],
    ["Browser", ["Headless browser", "Logged-in sessions", "Screenshots", "Form filling", "Download guard", "Captcha hand-off", "Co-browsing"]],
    ["Computer", ["Shell", "File editing", "Background jobs", "Desktop control", "Clipboard", "Screen reading", "App automation"]],
    ["Services", ["Calendar", "Contacts", "Payments guard", "Cloud storage", "Issue trackers", "CRM", "Analytics"]],
  ] },
  { id: "scheduling", name: "Scheduling and automation", groups: [
    ["Jobs", ["Cron jobs", "One-off reminders", "Run now", "Pause and resume", "Job history", "Job health", "Retry policy"]],
    ["Triggers", ["Webhooks", "File watchers", "Mail triggers", "Calendar triggers", "Git triggers", "Price watchers", "RSS"]],
    ["Workflows", ["Visual editor", "Approval gates", "Branching", "Loops", "Parallel steps", "Workflow versioning", "Dry run"]],
  ] },
  { id: "agents", name: "Multi-agent and delegation", groups: [
    ["Teams", ["Sub-agents", "Agent roles", "Shared scratchpad", "Hand-off", "Blind critic", "Verifier agent", "Agent budget"]],
    ["Routing", ["Model routing", "Free models first", "Quota pacing", "Fallback chain", "Per-task effort", "Cost cap", "Latency target"]],
    ["Remote", ["Cloud sessions", "Second machine", "Wake on demand", "Job offload", "Remote logs", "Remote stop", "Session resume"]],
  ] },
  { id: "control", name: "Safety and control", groups: [
    ["Permissions", ["Ask before sending", "Ask before spending", "Allowlists", "Per-tool approval", "Read-only mode", "Secrets vault", "Audit log"]],
    ["Observability", ["Live dashboard", "Token usage", "Cost per project", "Error alerts", "Process weight", "Traces", "Replay a turn"]],
    ["Updates", ["Safe update", "Rollback", "Release notes", "Canary channel", "Config backup", "Health check", "Self repair"]],
  ] },
];

const WEIGHT: Record<string, number> = { yes: 1, partial: 0.5, no: 0 };

/** The map, built so the totals are the real map's (172 features, 47 behind). */
export function featuresMap(now: number): Record<string, unknown> {
  const total = 172;
  const named = AREAS.reduce((n, a) => n + a.groups.reduce((m, [, leaves]) => m + leaves.length, 0), 0);
  // A copy, with the last group taking the few features the named lists do not reach.
  const plan = AREAS.map((a, ai) => ({ ...a, groups: a.groups.map(([g, leaves], gi): [string, string[]] => [g,
    ai === AREAS.length - 1 && gi === a.groups.length - 1 ? [...leaves, ...Array.from({ length: total - named }, (_, i) => `Guardrail ${i + 1}`)] : leaves]) }));
  let index = 0;
  const others = SYSTEMS.slice(1).map(([id]) => id);
  const score = (leaves: Array<{ status: Record<string, string> }>, id: string) => {
    let known = 0, got = 0;
    for (const l of leaves) { const w = WEIGHT[l.status[id] ?? ""]; if (w === undefined) continue; known++; got += w; }
    return { pct: known ? Math.round((100 * got) / known) : null, known };
  };
  const rank = (leaves: Array<{ status: Record<string, string> }>) => SYSTEMS.map(([id]) => ({ id, ...score(leaves, id) }))
    .filter((r) => r.pct !== null).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  const areas = plan.map((a) => {
    const children = a.groups.map(([gname, leaves], gi) => {
      const kids = leaves.map((name) => {
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
        const news = i % 4 === 0 ? [{ system: "example/agents", title: `${name}: new release notes`, url: `https://example.com/news/${i}`, date: new Date(now - (i % 9) * DAY).toISOString(), match: name.toLowerCase() }] : [];
        return { id: `${a.id}.${gi}.${i}`, name, desc: i % 6 === 0 ? `${name}, built in and configured once` : "", status, sources: [], keywords: [name.toLowerCase()], ours, have, of: others.length, behind: ours !== "yes" && have >= 3, news };
      });
      return { id: `${a.id}.${gi}`, name: gname, children: kids, ranking: rank(kids) };
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
    pyramid: null,
  };
}
