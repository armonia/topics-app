/**
 * What the fake hub adds for «Agenti e lavori» (`jobs`) past the queue and the
 * diary of fake-hub.ts: the hub's board (`board`: who works outside Topics, a
 * held job's reason, the projects' icons), its live agents per project
 * (`live`), the proxy's sessions with an account, a tool at work, an idle
 * session, a summary in the timeline and two sessions on one file, and the
 * calendar (`calendar`) with a reminder already late, one with its own
 * description and one with the agent's instructions. Placeholder names only.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A 1x1 PNG: the icon the hub serves for acme-web. */
export const FAKE_ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The hub's `/api/board`: its rows of work and its projects, as `buildBoard` writes them. */
export function jobsBoard(now: number): Record<string, unknown> {
  return {
    at: now,
    work: [
      { id: "ses:cli-out-1", kind: "sessione", title: "Test A/B con assegnazione all'edge", project: "acme-web", state: "in corso", stateText: "in corso", startedAt: now - 25 * MIN, agents: 1, tokens: 1_558_000, icon: "/api/project-icon?name=acme-web" },
      { id: "ses:cli-out-2", kind: "sessione", title: "Lavoro su studio-x", project: "studio-x", state: "in corso", stateText: "aspetta un comando", startedAt: now - 12 * MIN, agents: 1, tokens: 40_000 },
      { id: "ses:cli-in-topics", kind: "sessione", title: "Sessione che Topics conta già", project: "acme-api", state: "in corso", stateText: "in corso", startedAt: now - 5 * MIN, agents: 1, tokens: 1_000 },
      { id: "ses:/codex/2026/11/05/c.jsonl", kind: "sessione", title: "Migra il router di acme-api", project: "acme-api", state: "in corso", stateText: "in corso", startedAt: now - 9 * MIN, agents: 1, tokens: 220_000 },
      { id: "sub:sub-1", kind: "subagente", title: "Subagente su acme-web", project: "acme-web", state: "in corso", stateText: "in corso", startedAt: now - 3 * MIN, agents: 1, tokens: 30_000, icon: "/api/project-icon?name=acme-web" },
      { id: "wf:wf_live-1", kind: "workflow", title: "Workflow per «Protocolli dei canali»", project: "acme-docs", state: "in corso", stateText: "in corso", startedAt: now - 40 * MIN, agents: 4, tokens: 2_300_000 },
      { id: "q:j-q", kind: "delega", title: "Refactor del router", project: "studio-x", state: "in pausa", stateText: "in pausa: Claude frenato", why: "Claude frenato", until: now + 2 * HOUR, startedAt: now - HOUR },
    ],
    projects: [
      { name: "acme-web", display: "acme-web", icon: "/api/project-icon?name=acme-web" },
      { name: "studio-x", display: "studio-x", icon: null },
    ],
  };
}

/** The live agents of each project, as `/api/live` lists them: the Topics tab is marked so. */
const LIVE_AGENTS: Record<string, unknown[]> = {
  "acme-web": [
    { kind: "sessione", provider: "claude", model: "Opus", cliId: "cli-out-1", use: { tokens: 1_558_000, pct: 0.73 } },
    { kind: "sottoagente", provider: "claude", model: "Sonnet", cliId: "sub-1", depth: 1, use: { tokens: 30_000, pct: 0.02 } },
  ],
  "studio-x": [{ kind: "sessione", provider: "claude", harness: "jcode", model: "Opus", cliId: "cli-out-2" }],
  "acme-api": [
    { kind: "sessione", provider: "claude", model: "Opus", cliId: "cli-in-topics", open: { via: "tab Topics", url: "http://127.0.0.1:13333/tab/chat/x" } },
    { kind: "codex", provider: "codex", model: "GPT-5", file: "/codex/2026/11/05/c.jsonl", use: { tokens: 220_000, pct: 0.4 } },
  ],
  "acme-docs": [
    { kind: "workflow", provider: "claude", model: "Sonnet", cliId: "wf-a1", workflow: "wf_live-1", depth: 2 },
    { kind: "workflow", provider: "claude", model: "Sonnet", cliId: "wf-a2", workflow: "wf_live-1", depth: 2 },
  ],
};

/** The live projects with their agents: six at work outside Topics, one in a Topics tab. */
export function withLiveAgents(projects: unknown[]): unknown[] {
  return projects.map((p) => {
    const name = (p as { name?: string }).name ?? "";
    const list = LIVE_AGENTS[name];
    return list ? { ...(p as object), agents: { count: list.length, list } } : p;
  });
}

/** The proxy's sessions with what «Agenti e lavori» reads past the basics. */
export function withJobsSessions(base: Record<string, unknown>, now: number): Record<string, unknown> {
  const active = (base.active as Array<Record<string, unknown>>).map((s) => (s.id === "s-live"
    // Silent for seven minutes: waiting for its next input, not at work.
    ? { ...s, lastActiveAt: now - 7 * MIN }
    : { ...s, currentActivity: "Read /Users/demo/Projects/acme-web/README.md" }));
  const recent = (base.recent as Array<Record<string, unknown>>).map((s) => (s.id === "s-done"
    ? { ...s, timeline: [...(s.timeline as unknown[]), { type: "input", text: "PROMPT GREZZO della sessione" }, { type: "action", text: "Ha aggiornato l'indice dei documenti di acme-docs." }] }
    : s));
  return { ...base, active, recent, conflicts: [{ file: "/Users/demo/Projects/acme-web/src/router.ts", accounts: ["lavoro@example.com"], count: 2 }, { file: "-n", count: 2 }] };
}

/** The calendar: a reminder that did not fire yesterday, one today with its own words, a job with its cadence. */
export function jobsCalendar(now: number): Record<string, unknown> {
  const yesterday = new Date(now - 24 * HOUR);
  yesterday.setHours(23, 0, 0, 0);
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const laterToday = now + Math.min(HOUR, (endOfToday.getTime() - now) / 2);
  return { items: [
    { key: "cron:rem-late", kind: "promemoria", title: "Rispondere al preventivo di acme-api", when: "ieri, 23:00", next: yesterday.getTime(), says: "WhatsApp", level: "va", what: null, prompt: "ISTRUZIONI DELL'AGENTE per il preventivo" },
    { key: "cron:rem-pr", kind: "promemoria", title: "Ricordami di chiudere la PR di studio-x", when: "oggi", next: laterToday, says: null, means: "con una nota sulla card", level: "va", what: "Ti ricorda la PR di studio-x se è ancora aperta", prompt: null },
    { key: "task:check", kind: "compito", title: "Controllare il rinnovo del dominio", when: "ogni mattina alle 9", next: now + 3 * 24 * HOUR, says: "Discord", level: "va", what: null, prompt: null },
  ] };
}

/** Who runs each reminder, in the hub's model. */
export function jobsReminders(): unknown[] {
  return [{ key: "cron:rem-late", reminder: true, who: "Muse", title: "Rispondere al preventivo di acme-api" }];
}
