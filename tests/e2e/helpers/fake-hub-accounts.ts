/**
 * The parts of the fake usage hub behind «Account e quote» and «Consumi» that
 * go past the bars (HUBBR-10, HUBBR-12), in the shapes of the real proxy's
 * `/api/profiles` (`probeStats`, `queueStats`, each account's `attribution`,
 * `utilizationHistory`, `weeklyHistory`), the hub's `/api/board` (accounts
 * with the pace dial, the forecast, the extra windows, the bonus, the login
 * and who spent the last 24 hours) and `/api/projects` (per project the
 * requests and who made them, Muse per folder, the proxy's attribution),
 * trimmed. Placeholder names, as the rest of the fake.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The proxy's probes of the week and its queue now. */
export function proxyHealthExtras(): Record<string, unknown> {
  return {
    probeStats: { probeCount7d: 19_952, inputTokens: 109_472, outputTokens: 49_760 },
    queueStats: { inflight: 3, queued: 2, balanceMode: false, balanceInflight: 0, balanceWaiting: 0 },
  };
}

/**
 * One window's attribution: `bands` slices, the oldest first; the account in
 * use carried its last slices through the proxy, one slice moved outside it,
 * the first ones were not measured. The week is measured on enough of itself
 * (60% internal), the five hours too little to say more than an estimate.
 */
function attributionWindow(now: number, spanMs: number, mine: boolean, measured: boolean): Record<string, unknown> {
  const n = 12;
  const step = spanMs / n;
  const bands = Array.from({ length: n }, (_, i) => {
    const from = now - spanMs + i * step;
    const carried = mine && i >= 8 ? 40_000_000 * (i - 7) : 0;
    return { from, to: from + step, myTokens: carried, myCostUsd: carried / 1e6, requests: carried ? 30 : 0, deltaUtil: i < 2 ? null : i === 5 ? 0.04 : 0 };
  });
  const tokens = bands.reduce((s, b) => s + b.myTokens, 0);
  return {
    myTokens: tokens, myCostUsd: tokens / 1e6, requests: bands.reduce((s, b) => s + b.requests, 0),
    tokenBreakdown: { inputTokens: tokens * 0.002, outputTokens: tokens * 0.018, cacheReadTokens: tokens * 0.93, cacheCreationTokens: tokens * 0.05 },
    externalShare: measured ? 0.4 : 0.35, coverage: measured ? 0.6 : 0.1, bands,
  };
}

/** The proxy's per-account extras: attribution of both windows and their trend; the account in use climbs to its 92%. */
export function profileExtras(name: string, isActive: boolean, now: number): Record<string, unknown> {
  const fiveH = Array.from({ length: 12 }, (_, i) => ({ ts: now - (23 - 2 * i) * HOUR, u5h: isActive ? Math.min(0.3, 0.03 * i) : 0.12, u7d: 0.5 }));
  const week = Array.from({ length: 7 }, (_, i) => ({ ts: now - (6 - i) * DAY - HOUR, u5h: 0, u7d: isActive ? 0.2 + 0.12 * i : 0.31 }));
  return {
    attribution: { fiveH: attributionWindow(now, 5 * HOUR, isActive, false), sevenD: attributionWindow(now, 7 * DAY, isActive, true) },
    utilizationHistory: name === "prof-d" ? [] : fiveH,
    weeklyHistory: name === "prof-d" ? [] : week,
  };
}

const access = (state: string, say: string, link: string) => ({
  state, since: null, say, link,
  resets: { fiveHour: { at: null, say: "Finestra di 5 ore: si azzera alle 19:00" }, week: { at: null, say: "Settimana: si azzera gio alle 13:00" } },
});

/**
 * The hub's board accounts: the Claude account in use over its pace, with its
 * forecast, its 24 hours past the daily share, the per-model window and a
 * bonus; Codex under its pace; Muse over it; and a Codex account whose login
 * died, which neither the proxy nor the hub's pace lists.
 */
export function boardAnswer(now: number): Record<string, unknown> {
  return {
    at: now,
    accounts: [
      {
        id: "claude:lavoro@example.com", provider: "claude", email: "lavoro@example.com", used: 92,
        gauge: { value: 1.7, needle: 1.7, zone: "sopra", reason: "settimana 92% su 55% trascorso; ultime 24 h 30% su 14% al giorno" },
        state: { dial: true, zone: "sopra", tone: "warn", text: "sopra ritmo" },
        windows: [
          { key: "week", label: "7 g", used: 92, mark: 55, tone: "warn" },
          { key: "5h", label: "5 h", used: 30, tone: "ok" },
          { key: "day", label: "24 h", used: 30, mark: 14, note: "sost. 14%/g", tone: "bad" },
          { key: "model:Fable", label: "Fable", used: 12, reset: "gio 13:00", tone: "ok" },
        ],
        bonus: { left: 40, limit: 250, used: 84, renews: "05/12", stale: false },
        access: access("ok", "Collegato dal 23 ott 2026.", "https://claude.ai/settings/usage"),
        top: [{ name: "acme-web", tokens: 305_000_000, pct: 77 }, { name: "Fuori da un progetto", tokens: 41_000_000, pct: 10 }],
        topNote: null,
        end: { text: "sab 04:46", tone: "bad", hint: "al ritmo delle ultime 24 h finisce domani alle 04:46" },
        tokens: { left: "~360 M", perDay: "380 M/24 h", hint: "stima: 9 M token pesati per punto di quota" },
      },
      {
        id: "codex:codex@example.com", provider: "codex", email: "codex@example.com", used: 28,
        gauge: { value: 0.5, needle: 0.5, zone: "sotto", reason: "settimana 28% su 55% trascorso" },
        state: { dial: true, zone: "sotto", tone: "ok", text: "sotto ritmo" },
        windows: [{ key: "week", label: "7 g", used: 28, mark: 55, tone: "ok" }, { key: "day", label: "24 h", used: 6, mark: 18, note: "sost. 18%/g", tone: "ok" }],
        bonus: null,
        access: access("ok", "Collegato dal 31 ago 2026.", "https://chatgpt.com/codex/settings/usage"),
        top: null, topNote: "per Codex il dettaglio per lavoro non c'è: non passa dal proxy",
        end: { text: "al reset", tone: "ok", hint: "al ritmo delle ultime 24 h arriva al reset" },
        tokens: { left: "~130 M", perDay: "16 M/24 h", hint: null },
      },
      {
        id: "muse:muse@example.com", provider: "muse", email: "muse@example.com", used: 61,
        gauge: { value: 1.5, needle: 1.5, zone: "sopra", reason: "settimana 61% su 40% trascorso" },
        state: { dial: true, zone: "sopra", tone: "warn", text: "sopra ritmo" },
        windows: [{ key: "week", label: "7 g", used: 61, mark: 40, tone: "warn" }], bonus: null,
        access: access("ok", "Collegato, data non nota.", "https://accountscenter.meta.com/subscriptions"),
        top: null, topNote: "per Muse il dettaglio per lavoro non c'è: non passa dal proxy", end: { text: "al reset", tone: "ok", hint: null }, tokens: null,
      },
      {
        id: "codex:vecchio@example.com", provider: "codex", email: "vecchio@example.com", used: null,
        gauge: { value: null, needle: null, zone: "ignoto", reason: "senza un accesso valido la quota non si legge e l'account non riceve lavoro" },
        state: { icon: "triangle-alert", tone: "bad", text: "accesso da rifare" },
        windows: [], bonus: null,
        access: { ...access("scaduto", "Accesso scaduto: esci e rientra.", "https://chatgpt.com/codex/settings/usage"), resets: { fiveHour: { at: null, say: "Finestra di 5 ore: reset non noto" }, week: { at: null, say: "Settimana: reset non noto" } } },
        top: null, topNote: null, end: null, tokens: null,
      },
    ],
  };
}

/**
 * The hub's weekly report: per project the Claude share with the requests and
 * who made them, Muse per folder (more than six, so the rest opens), and the
 * proxy's attribution with a folder recovered from the session logs.
 */
export function projectsReport(now: number): Record<string, unknown> {
  const project = (name: string, weekPct: number, requests: number, tokens: number, extra: Record<string, number> = {}) =>
    ({ name, weekPct, requests, tokens, subRequests: 0, subWeekPct: 0, jarvisRequests: 0, jarvisWeekPct: 0, jcodeRequests: 0, jcodeWeekPct: 0, lastAt: now - HOUR, ...extra });
  const muse = (name: string, weekPct: number, requests: number, tokens: number) => ({ name, weekPct, requests, tokens, lastAt: now - 2 * HOUR });
  return {
    projects: [
      project("acme-web", 30, 9_231, 256_833_791, { subRequests: 7_522, subWeekPct: 15.3, jcodeRequests: 75, jcodeWeekPct: 0.1, jarvisRequests: 12, jarvisWeekPct: 0.4 }),
      project("studio-x", 25, 4_100, 120_000_000),
    ],
    muse: {
      quota: { label: "muse@example.com", weekPct: 61 },
      projects: [
        muse("acme-web", 41.5, 3_499, 6_000_000), muse("studio-x", 20, 302, 3_100_000), muse("acme-api", 9, 120, 900_000), muse("acme-docs", 5, 40, 300_000),
        muse("misc-a", 3, 20, 100_000), muse("misc-b", 2, 10, 50_000), muse("misc-c", 1, 4, 20_000),
      ],
    },
    proxy: {
      available: true, requests: 14_569, withoutCwd: 3, blindSessions: 27, coverage: { from: now - 30 * HOUR, to: now - 60_000 },
      projects: [{ name: "acme-web", tokens: 314_220_676, requests: 11_251, needsLogs: false }, { name: "studio-x", tokens: 20_321_740, requests: 697, needsLogs: true }],
    },
  };
}

/**
 * Proxy rows past the acme-web ones: a studio-x branch, a row with no folder,
 * and an account the proxy no longer has, so «By folder and branch» has two
 * folders and the empty one, and «Per account» a removed account.
 */
export function extraProxyRows(now: number): unknown[] {
  const row = (ts: number, repo: string, branch: string, account: string, outputTokens: number) =>
    ({ ts, repo, branch, model: "claude-sonnet-5-5", account, inputTokens: 1_000, outputTokens, cacheReadTokens: 4_000_000, cacheCreationTokens: 100_000, cwd: repo });
  return [
    row(now - 2 * HOUR, "/w/studio-x", "feat/conti", "lavoro@example.com", 500_000),
    row(now - 3 * HOUR, "/w/studio-x", "main", "riserva@example.com", 200_000),
    row(now - 4 * HOUR, "", "", "lavoro@example.com", 50_000),
    row(now - 5 * HOUR, "/w/acme-web", "main", "vecchio@example.com", 300_000),
  ];
}
