// Watch board tasks and emit one line per state change — built for the Claude
// Code `Monitor` tool (each stdout line becomes a notification), usable from
// any terminal too.
//
//   bun run scripts/watch-board-tasks.ts \
//     [--project topics-app-ar3jt5] [--tasks id1,id2] [--interval 20] [--until-idle]
//
// - No --tasks ⇒ watches every root task on the board.
// - --until-idle ⇒ exits (code 0) when none of the watched tasks is still in
//   todo/in_progress — gives the watch a natural end on delivery/failure.
// - Emits on: status change, dispatch-chip change, model change; on →review it
//   also prints the agent's last comment (the delivery summary). A server that
//   stops answering is surfaced after 5 consecutive failures — silence must
//   never look like "still working".

export {}; // top-level await richiede un modulo

const argv = process.argv.slice(2);
function opt(name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PROJECT = opt("project", "topics-app-ar3jt5");
const INTERVAL_S = Math.max(5, Number(opt("interval", "20")) || 20);
const UNTIL_IDLE = argv.includes("--until-idle");
const ONLY = new Set(opt("tasks", "").split(",").map((s) => s.trim()).filter(Boolean));
const BASE = `https://localhost:3333/api/boards/${PROJECT}/tasks`;

// The server speaks TLS with its own self-signed cert (repo convention:
// `curl -k` on :3333). Verification is relaxed PER REQUEST and only for this
// hardcoded loopback origin — never process-wide, never for remote hosts.
const TLS_LOOPBACK = { tls: { rejectUnauthorized: false } } as RequestInit;

type Row = { id: string; text: string; status: string; parentTaskId?: string | null; dispatchState?: string | null; model?: string | null };
type Snap = { status: string; chip: string; model: string };

const ACTIVE = new Set(["todo", "in_progress"]);
const ts = () => new Date().toTimeString().slice(0, 5);
const say = (msg: string) => console.log(`[${ts()}] ${msg}`);

async function fetchTasks(): Promise<Row[]> {
  const res = await fetch(BASE, TLS_LOOPBACK);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = (await res.json()) as Row[] | { tasks: Row[] };
  return Array.isArray(d) ? d : d.tasks ?? [];
}

async function lastAgentComment(taskId: string): Promise<string> {
  try {
    const res = await fetch(`${BASE}/${taskId}`, TLS_LOOPBACK);
    const d = (await res.json()) as { comments?: { author: string; kind?: string; content?: string }[] };
    const c = [...(d.comments ?? [])].reverse()
      .find((x) => x.author !== "user" && x.author !== "system" && x.kind !== "status" && x.content);
    return c?.content?.replace(/\s+/g, " ").slice(0, 200) ?? "";
  } catch {
    return "";
  }
}

let prev = new Map<string, Snap>();
let first = true;
let errStreak = 0;

for (;;) {
  try {
    const rows = (await fetchTasks()).filter((t) => !t.parentTaskId && (ONLY.size === 0 || ONLY.has(t.id)));
    errStreak = 0;
    const cur = new Map<string, Snap>();
    for (const t of rows) {
      const snap: Snap = { status: t.status, chip: t.dispatchState ?? "-", model: t.model ?? "auto" };
      cur.set(t.id, snap);
      const old = prev.get(t.id);
      const title = t.text.slice(0, 55);
      if (first) {
        if (ONLY.size) say(`watch: "${title}" — ${snap.status} (chip ${snap.chip}, ${snap.model})`);
        continue;
      }
      if (!old) { say(`NUOVO "${title}" — ${snap.status} (chip ${snap.chip})`); continue; }
      if (old.status !== snap.status || old.chip !== snap.chip || old.model !== snap.model) {
        let line = `"${title}" — ${old.status}→${snap.status} | chip ${old.chip}→${snap.chip}`;
        if (old.model !== snap.model) line += ` | model ${old.model}→${snap.model}`;
        say(line);
        if (snap.status === "review" && old.status !== "review") {
          const c = await lastAgentComment(t.id);
          if (c) say(`  └ consegna: ${c}`);
        }
        if (snap.status === "backlog" && snap.chip === "failed") say(`  └ ATTENZIONE: parcheggiato come failed — servono occhi umani`);
      }
    }
    // A watched task that vanished (archived/deleted) must not go silent.
    if (!first) for (const [id, old] of prev) if (!cur.has(id)) say(`SPARITO task ${id.slice(0, 8)} (era ${old.status}) — archiviato?`);
    prev = cur;
    first = false;
    if (UNTIL_IDLE && ![...cur.values()].some((s) => ACTIVE.has(s.status))) {
      say("nessun task osservato ancora attivo — watch concluso.");
      process.exit(0);
    }
  } catch (e) {
    errStreak++;
    if (errStreak === 5) say(`SERVER MUTO da ${5 * INTERVAL_S}s (${e instanceof Error ? e.message : e}) — riavvio in corso o problema vero`);
  }
  await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
}
