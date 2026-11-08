/**
 * The hub's automations for «Automazioni» (fake-hub.ts with `automations`
 * on): the model in the hub's shape, its summary, the calendar, the runs of an
 * Jarvis job and the cost of a workflow run, with placeholder names.
 *
 * The votes, notes and silences posted to `feedback` are kept as rows and
 * folded into the cards' `feedback` the way the hub rebuilds it, so a read
 * after a write shows what was written, and only that.
 *
 * Scene: two broken (the docs index on Jarvis, the Mac backup on launchd) and
 * one waiting on you (the weekly summary, changed after your «va bene»); the
 * rest in order, a hidden one that must not show, a GitHub job, a PC job and
 * a workflow with two runs, and a workflow step waiting for your ok (a gate,
 * which «Decidi tu» leaves out). The index also holds a broken app of the
 * computer and a task waiting on you, which the hub keeps out of its verdict:
 * the task stays out of the view, the app shows in «Computer e app» only.
 *
 * Around the cards, as the hub serves them: the copy is the last good one
 * (`stale`), the tokens per provider, the sources (GitHub silent, the PC
 * asleep), a hidden job, a brake on the docs index; the docs index carries its
 * purpose, cost, project, steps and scheme (`automations/graph`), and its runs
 * say whether they wrote to you. A feedback row can be taken back (`undo`).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

export type FeedbackRow = Record<string, unknown> & { kind: string; key?: string; at: string };

/** A run every `everyMin` minutes over the last day, newest first; `bad` are the newest failed ones. */
function runs(now: number, everyMin: number, bad = 0): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (let t = now - 13 * MIN, i = 0; t > now - 24 * HOUR; t -= everyMin * MIN, i++) out.push([t, i < bad ? "error" : "ok"]);
  return out;
}

function feedbackFor(key: string, rows: FeedbackRow[]): Record<string, unknown> {
  const undone = new Set(rows.filter((r) => r.kind === "undo").map((r) => r.ref));
  const mine = rows.filter((r) => r.key === key && !undone.has(r.id));
  const vote = [...mine].reverse().find((r) => r.kind === "vote") ?? null;
  const mute = [...mine].reverse().find((r) => r.kind === "mute") ?? null;
  const notes = mine.filter((r) => r.kind === "note" || r.kind === "complaint").map((r) => ({ at: r.at, note: r.note, kind: r.kind }));
  return {
    vote: vote ? { v: vote.v, at: vote.at, fp: vote.fp ?? null, note: vote.note ?? null } : null,
    changedSinceVote: false,
    mute: mute ? { until: mute.until ?? null, why: mute.why } : null,
    open: notes.length,
    notes,
  };
}

interface CardSeed {
  key: string;
  provider: string;
  title: string;
  level: "te" | "rotto" | "va" | "nascosto";
  when: string;
  cosa: string;
  reason?: string;
  since?: number;
  next?: number | null;
  day?: Array<[number, string]>;
  exit?: number | null;
  error?: string | null;
  /** The rest of the card, as the hub writes it. */
  extra?: Record<string, unknown>;
}

function seeds(now: number): CardSeed[] {
  const docs = runs(now, 60, 2);
  return [
    { key: "cron:job-docs", provider: "jarvis", title: "Indice dei documenti", level: "rotto", when: "ogni ora", cosa: "Reindicizza le note di acme-docs per la ricerca.", reason: "Fallisce da 2 giri: la cartella acme-docs/notes non esiste più", since: now - 73 * MIN, next: now + 47 * MIN, day: docs, exit: 1, error: "cartella non trovata", extra: {
      purpose: { area: "jarvis-agenti", cosaFaPerTe: "Reindicizza le note di acme-docs per la ricerca.", seSiRompe: "Attilio potrebbe cercare una nota di acme-docs e non trovarla." },
      usage: { kind: "tokens", d1: { muse: 12_000 }, d7: { muse: 80_000, claude: 4_000 } },
      who: "Muse Spark, poi Sonnet", means: "niente, se va tutto bene",
      project: { name: "acme-docs", icon: "/api/project-icon?name=acme-docs" },
      where: { icon: "jarvis", label: "Jarvis" },
      flow: { steps: 3, ai: true, nodes: [
        { kind: "step", label: "legge le note" },
        { kind: "model", label: "Muse → Sonnet", who: [{ name: "Muse", brand: "muse" }, { name: "Sonnet", brand: "claude" }] },
        { kind: "deliver", label: "WhatsApp", brand: "whatsapp" },
      ] },
      tech: { exit: 1, schedule: "0 * * * *", command: "node ~/bin/reindex.mjs --root acme-docs/notes", prompt: null },
    } },
    { key: "cron:job-week", provider: "jarvis", title: "Riepilogo settimanale su Discord", level: "te", when: "il lunedì alle 9:00", cosa: "Il lunedì riassume la settimana di acme-web su Discord.", reason: "è cambiata dopo il tuo «va bene»", since: now - 3 * 24 * HOUR, next: now + 4 * 24 * HOUR, day: [] },
    { key: "cron:job-mail", provider: "jarvis", title: "Avviso mail importanti", level: "va", when: "ogni minuto", cosa: "Legge la posta e avvisa solo per quella importante.", next: now + MIN, day: runs(now, 60), extra: {
      warn: "si sta riprendendo dopo 3 errori di fila", delivered: "delivered", usage: { kind: "unmeasured" }, nextApprox: true, group: "arriva",
      proof: { ok: true, words: "ultimo avviso arrivato alle 22:25" }, sources: [{ provider: "jarvis" }, { provider: "health" }],
    } },
    { key: "cron:job-day", provider: "jarvis", title: "Giornata di lavoro nel calendario", level: "va", when: "ogni 30 min", cosa: "Scrive i blocchi di lavoro nel calendario.", next: now + 20 * MIN, day: runs(now, 60).slice(0, 14) },
    { key: "cron:job-brief", provider: "jarvis", title: "Brief del mattino", level: "va", when: "ogni giorno alle 7:30", cosa: "Il brief del mattino su WhatsApp.", next: now + 9 * HOUR, day: [[now - 15 * HOUR, "ok"]] },
    { key: "cron:job-sync", provider: "jarvis", title: "Promemoria e board allineati", level: "va", when: "ogni 10 min", cosa: "Allinea i promemoria con la board.", next: now + 4 * MIN, day: runs(now, 60) },
    { key: "cron:job-costs", provider: "jarvis", title: "Costi della settimana", level: "va", when: "il venerdì alle 18:00", cosa: "Riepilogo dei costi di acme-web.", next: now + 2 * 24 * HOUR, day: [] },
    { key: "health:job-mail", provider: "health", title: "Consegne di Avviso mail", level: "va", when: "ogni giorno", cosa: "Controlla che gli avvisi arrivino.", day: [] },
    { key: "launchd:com.example.backup", provider: "launchd", title: "Backup del Mac", level: "rotto", when: "ogni giorno alle 5:00", cosa: "Copia cifrata del Mac in iCloud.", reason: "Stanotte non è partito: il Mac dormiva alle 5:00", since: now - 17 * HOUR, next: now + 7 * HOUR, day: [[now - 17 * HOUR, "error"]], exit: 1 },
    { key: "launchd:com.example.memlog", provider: "launchd", title: "Memoria del Mac nel tempo", level: "va", when: "ogni 5 min", cosa: "Scrive la memoria del Mac ogni 5 minuti.", next: now + 2 * MIN, day: runs(now, 60), exit: 0, extra: { usage: { kind: "script" } } },
    { key: "launchd:com.example.maint", provider: "launchd", title: "Manutenzione notturna", level: "va", when: "ogni giorno alle 2:30", cosa: "Pulizie della notte.", next: now + 4 * HOUR, day: [[now - 20 * HOUR, "ok"]], exit: 0 },
    { key: "launchd:com.example.off", provider: "launchd", title: "Vecchio controllo spento", level: "nascosto", when: "ogni ora", cosa: "Spento apposta." },
    { key: "gh:acme/acme-web/nightly.yml", provider: "github", title: "Prove notturne di acme-web", level: "va", when: "ogni giorno alle 4:17", cosa: "Prova acme-web da capo a fondo.", next: now + 6 * HOUR, day: [[now - 18 * HOUR, "ok"]], extra: {
      tech: { exit: 0, schedule: "17 4 * * *", command: null, prompt: null, url: "https://github.com/acme/acme-web/actions/runs/42" },
    } },
    { key: "lobster:release", provider: "lobster", title: "Rilascio di acme-web", level: "te", when: "a mano", cosa: "Pubblica acme-web dopo le prove.", reason: "aspetta il tuo ok al passo «pubblica»", since: now - 2 * HOUR },
    { key: "pc:suite", provider: "pc", title: "Suite sul PC", level: "va", when: "ogni notte", cosa: "Le suite pesanti sul PC di casa.", day: [[now - 19 * HOUR, "ok"]] },
  ];
}

/** A broken app of the computer and a task waiting on you: in the hub's index, never rows of this view. */
const OWN_SEED: CardSeed = { key: "launchd:com.example.darkroom", provider: "launchd", title: "App del Mac di prova", level: "rotto", when: "all'avvio", cosa: "Una app del Mac, solo da guardare.", reason: "non risponde" };
const TASK_SEED: CardSeed = { key: "cron:task-quote", provider: "jarvis", title: "Chiedere il preventivo a studio-x", level: "te", when: "fra 4 giorni", cosa: "Un compito con una scadenza." };

function cardOf(s: CardSeed, now: number, feedback: FeedbackRow[]): Record<string, unknown> {
  const day = s.day ?? [];
  const last = day[0] ?? null;
  return {
    key: s.key, provider: s.provider, title: s.title, kind: "automazione", cosa: s.cosa, when: s.when, next: s.next ?? null,
    last: { at: last ? last[0] : null, outcome: last ? last[1] : null, delivered: s.extra?.delivered ?? null, error: last && last[1] === "error" ? s.error ?? null : null },
    history: day.slice(0, 10).map(([at, outcome]) => ({ at, outcome })), day,
    purpose: { cosaFaPerTe: s.cosa }, runsToday: day.filter(([at]) => at > now - 12 * HOUR).length,
    level: s.level, reason: s.reason ?? "gira come deve", since: s.since ?? null,
    tech: { exit: s.exit ?? null, schedule: null, command: null, prompt: null },
    feedback: feedbackFor(s.key, feedback), fp: `fp-${s.key}`,
    ...s.extra,
  };
}

export function automationsModel(now: number, feedback: FeedbackRow[]): Record<string, unknown> {
  // As the hub builds it: the hidden ones nowhere, the judged ones in
  // needsYou, broken and the groups, and the `cards` index holding the
  // computer's own apps and the tasks too, outside the verdict.
  const list = seeds(now).filter((s) => s.level !== "nascosto").map((s) => cardOf(s, now, feedback)) as Array<Record<string, unknown> & { key: string; level: string }>;
  const own = { ...cardOf(OWN_SEED, now, feedback), own: true, purpose: { area: "computer-app", cosaFaPerTe: OWN_SEED.cosa } };
  const task = { ...cardOf(TASK_SEED, now, feedback), kind: "compito" };
  const cards: Record<string, unknown> = { [OWN_SEED.key]: own, [TASK_SEED.key]: task };
  for (const c of list) cards[c.key] = c;
  return {
    checkedAt: now - 30_000,
    stale: true,
    verdict: { needsYou: 2, broken: 2, ok: 10, hidden: 1, tasks: 1, own: 1, runsToday: 412 },
    needsYou: list.filter((c) => c.level === "te"),
    broken: list.filter((c) => c.level === "rotto"),
    groups: [{ id: "macchine", title: "Macchine", cards: list.filter((c) => c.level === "va") }],
    own: [own],
    tasks: [task],
    reminders: [{ key: "cron:rem-pr", provider: "jarvis", title: "Ricordami di chiudere la PR di acme-api", reminder: true, level: "va", who: "Jarvis (lavori programmati)" }],
    cards,
    usage: { d1: { muse: 12_000 }, d7: { muse: 80_000, claude: 4_000 }, unmeasured: 1, script: 1 },
    footer: {
      sources: [
        { name: "jarvis", label: "Jarvis", ok: true, at: now - 2 * MIN, pending: false, note: null },
        { name: "launchd", label: "Mac (launchd)", ok: true, at: now - 2 * MIN, pending: false, note: null },
        { name: "github", label: "GitHub", ok: false, at: null, pending: false, note: "?" },
        { name: "pc", label: "PC di casa", ok: true, at: null, pending: false, note: "PC dorme" },
      ],
      hidden: { count: 1, why: [{ title: "Vecchio controllo spento", reason: "silenziata fino al 12/11" }] },
    },
    brakes: { "cron:job-docs": { stateText: "in pausa fino alle 23:00 perché Claude è al 92%", until: now + 34 * MIN } },
    workflows: { days: 7, total: 2, failed: 1, byName: [
      { name: "audit-dipendenze", total: 2, failed: 1, runs: [
        { runId: "wf_e2e-audit-2", at: now - 2 * HOUR, outcome: "error", durationMs: 3 * MIN, agents: 1, phases: [] },
        { runId: "wf_e2e-audit-1", at: now - 26 * HOUR, outcome: "ok", durationMs: 6 * MIN, agents: 2, phases: [] },
      ] },
    ] },
  };
}

export function automationsSummary(now: number): Record<string, unknown> {
  return { needsYou: 2, broken: 2, ok: 10, hidden: 1, runsToday: 412, checkedAt: now - 30_000, calendar: { count: 3, next: { title: "Chiudere la PR di acme-api", at: now + HOUR, kind: "promemoria" } } };
}

export function automationsCalendar(now: number): Record<string, unknown> {
  const tomorrow = new Date(now + 24 * HOUR);
  tomorrow.setHours(10, 0, 0, 0);
  // «Today» stays today after 23:00: an hour ahead would land tomorrow.
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const laterToday = now + Math.min(HOUR, (endOfToday.getTime() - now) / 2);
  return { items: [
    { key: "cron:rem-pr", kind: "promemoria", title: "Ricordami di chiudere la PR di acme-api", when: "oggi", next: laterToday, says: "WhatsApp", level: "va", what: "Ti ricorda di chiudere la PR di acme-api prima di sera.", means: "un messaggio breve con il link alla PR", prompt: "PROMPT GREZZO DEL PROMEMORIA" },
    { key: "cron:rem-domain", kind: "promemoria", title: "Rinnovo del dominio acme-web.example", when: "domani", next: tomorrow.getTime(), says: null, level: "va", what: null, prompt: null },
    { key: "task:quote", kind: "compito", title: "Chiedere il preventivo a studio-x", when: "fra 4 giorni", next: now + 4 * 24 * HOUR, says: "Discord", level: "va", what: null, prompt: null },
  ] };
}

export function automationsRuns(now: number, key: string): Record<string, unknown> | null {
  if (key !== "cron:job-docs") return key.startsWith("cron:") ? { runs: [], more: false, total: 0 } : null;
  return { runs: [
    { at: now - 13 * MIN, ms: 400, outcome: "error", text: null, error: "cartella non trovata\n    at reindex (~/bin/reindex.mjs:12)", manual: true, wrote: null, whyNot: "niente da dire" },
    { at: now - 73 * MIN, ms: 300, outcome: "error", text: null, error: "cartella non trovata", wrote: null, whyNot: "niente da dire" },
    { at: now - 133 * MIN, ms: 6100, outcome: "ok", text: "412 schede, 3 nuove", wrote: { channel: "whatsapp" }, model: "claude-sonnet-5-5", tokens: 12_400,
      report: { path: "~/.cache/reindex/2026-11-05.md", text: "# Indice\n412 schede, 3 nuove: acme-docs/notes" } },
    { at: now - 193 * MIN, ms: 5800, outcome: "ok", text: "409 schede", wrote: null, whyNot: "niente da dire" },
  ], more: false, total: 4 };
}

/** The docs index's scheme, as the hub draws it from the job, its script and its log; the others have none. */
export function automationsGraph(now: number, key: string): Record<string, unknown> | null {
  if (key !== "cron:job-docs") return null;
  return {
    key, title: "Indice dei documenti", run: { at: now - 13 * MIN, ms: 400, outcome: "error" }, from: ["job di Jarvis", "~/bin/reindex.mjs"],
    nodes: [
      { id: "trigger", kind: "trigger", label: "pianificato da Jarvis", params: [{ k: "Ripete", v: "ogni ora" }] },
      { id: "s0", kind: "step", label: "legge le note di acme-docs", detail: "~/Projects/acme-docs/notes", outcome: "error", error: "cartella non trovata", command: "node ~/bin/reindex.mjs --root acme-docs/notes" },
      { id: "model", kind: "model", label: "Modello, con ripiego", options: [
        { exec: "muse", name: "Muse", model: "muse-spark-1.3", outcome: "error", ms: 900, note: "quota finita" },
        { exec: "claude", name: "Claude", model: "claude-sonnet-5-5", outcome: "ok", ms: 3_100, tokens: 9_000 },
        { exec: "codex", name: "Codex", model: "gpt-5.6-sol", outcome: null },
      ], io: { in: "Riassumi le schede nuove di acme-docs", out: "3 schede nuove", outFrom: "Claude" } },
      { id: "deliver", kind: "deliver", label: "WhatsApp", outcome: "skipped" },
    ],
  };
}

export function workflowRunCost(runId: string): Record<string, unknown> | null {
  return runId.startsWith("wf_e2e-") ? { ok: true, agents: 2, weighted: 120_000, weekPct: 0.42, estimate: true } : null;
}

/** The hub's own check on a feedback row, trimmed to what this view sends. */
export function feedbackRefusal(row: Record<string, unknown>): string | null {
  if (!["vote", "note", "complaint", "mute", "undo"].includes(String(row.kind))) return `kind sconosciuto: ${String(row.kind)}`;
  if (row.kind === "undo") return row.ref ? null : "manca ref per undo";
  if (!row.key) return `manca key per ${String(row.kind)}`;
  if (row.kind === "vote" && !["ok", "cambia", "indietro"].includes(String(row.v))) return "voto non valido";
  if (row.kind === "vote" && row.v === "cambia" && !row.note) return "manca note per il voto cambia";
  if ((row.kind === "note" || row.kind === "complaint") && !row.note) return `manca note per ${String(row.kind)}`;
  if (row.kind === "mute" && (!row.why || row.until === undefined)) return "manca why o until per mute";
  return null;
}
