/**
 * What runs on each machine: a card with no machine is this computer, a card
 * of a node is that node's, and every state the tray shows is derived (never
 * stored) from the board rows and the open chat turns.
 * @covers HUBBR-08
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { projectIdForPath } from "../../shared/board";
import { TASKS_DDL, TASKS_FK_STUBS_DDL } from "../db/test-schema";
import { topicSessionKey } from "./agent-census";
import { MAX_AGENT_ITEMS, readMachineAgents, shortTitle } from "./machine-agents";

const NOW = Date.parse("2026-11-18T10:00:00.000Z");
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const H = 3_600_000;
const D = 24 * H;

const LEDGER = projectIdForPath("/work/ledger");
const TOPICS = projectIdForPath("/work/topics-app");
const MAC = "mac-now";
const MAC_OLD = "mac-old-hostname";
const PC = "pc-windows";
const CLOUD = "nodo-cloud";
const MACHINES = [
  { id: MAC, baseUrl: null },
  { id: MAC_OLD, baseUrl: null },
  { id: PC, baseUrl: "http://127.0.0.1:3393" },
  { id: CLOUD, baseUrl: "http://127.0.0.1:3401" },
];

let db: Database;
let n = 0;

function freshDb(): Database {
  const d = new Database(":memory:");
  d.run("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)");
  d.run("CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT NOT NULL)");
  d.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT, session_key TEXT NOT NULL, project_path TEXT,
    worktree_id TEXT, archived INTEGER NOT NULL DEFAULT 0, icon TEXT)`);
  d.run(TASKS_DDL);
  // The stub `topics` is a no-op: the real shape above already exists.
  d.run(TASKS_FK_STUBS_DDL);
  d.run("INSERT INTO projects (id, name, path) VALUES ('p-ledger', 'Ledger', '/work/ledger'), ('p-topics', 'Topics', '/work/topics-app')");
  return d;
}

type Card = Partial<{
  text: string; status: string; project: string; machine: string | null; chip: string | null; error: string | null;
  ask: string | null; inProgressAt: string; reviewAt: string; updatedAt: string; creatorTopic: string | null; assignedTopic: string | null;
  archived: number;
}>;

function card(c: Card): void {
  n++;
  db.prepare(
    `INSERT INTO tasks (id, project_id, text, status, machine_id, dispatch_state, dispatch_error, human_ask,
       in_progress_at, review_at, created_by_topic_id, assigned_topic_id, archived, created_at, updated_at)
     VALUES ($id, $project, $text, $status, $machine, $chip, $error, $ask, $ip, $rv, $creator, $assigned, $archived, $created, $updated)`,
  ).run({
    $id: `t${n}`, $project: c.project ?? LEDGER, $text: c.text ?? `Card ${n}`, $status: c.status ?? "todo",
    $machine: c.machine ?? null, $chip: c.chip ?? null, $error: c.error ?? null, $ask: c.ask ?? null,
    $ip: c.inProgressAt ?? null, $rv: c.reviewAt ?? null, $creator: c.creatorTopic ?? null, $assigned: c.assignedTopic ?? null,
    $archived: c.archived ?? 0, $created: iso(10 * D), $updated: c.updatedAt ?? iso(H),
  });
}

function topic(id: string, name: string, extra: { path?: string; worktreeProject?: string; archived?: number } = {}): string {
  const key = topicSessionKey(id);
  if (extra.worktreeProject) db.prepare("INSERT INTO worktrees (id, project_id) VALUES (?, ?)").run(`w-${id}`, extra.worktreeProject);
  db.prepare("INSERT INTO topics (id, name, session_key, project_path, worktree_id, archived) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, key, extra.path ?? null, extra.worktreeProject ? `w-${id}` : null, extra.archived ?? 0);
  return key;
}

function read(opts: { openChats?: Array<[string, number | null]>; parked?: string[] } = {}) {
  return readMachineAgents({
    db, machines: MACHINES, localId: MAC,
    openChats: new Map(opts.openChats ?? []), parkedChats: opts.parked ?? [], now: NOW,
  });
}

beforeEach(() => { db = freshDb(); n = 0; });

describe("which machine a card is on", () => {
  test("a card with no machine, or on an older hostname of this Mac, is this computer's; a node's card is that node's", () => {
    card({ status: "todo", machine: null });
    card({ status: "todo", machine: MAC_OLD });
    card({ status: "todo", machine: PC });
    card({ status: "todo", machine: CLOUD });
    card({ status: "todo", machine: CLOUD });
    const out = read();
    expect(out.get(MAC)!.queued).toBe(2);
    expect(out.get(PC)!.queued).toBe(1);
    expect(out.get(CLOUD)!.queued).toBe(2);
    expect(out.get(MAC_OLD)!.queued).toBe(0);
  });

  test("archived cards and backlog/done are not agents", () => {
    card({ status: "in_progress", chip: "working", archived: 1 });
    card({ status: "backlog" });
    card({ status: "done" });
    const a = read().get(MAC)!;
    expect(a.working + a.queued + a.review + a.waiting + a.idle).toBe(0);
  });
});

describe("the state of a card", () => {
  test("in_progress with a live chip works, on this machine and on a node", () => {
    card({ status: "in_progress", chip: "working" });
    card({ status: "in_progress", chip: "starting" });
    card({ status: "in_progress", chip: "working", machine: PC });
    const out = read();
    expect(out.get(MAC)!.working).toBe(2);
    expect(out.get(PC)!.working).toBe(1);
  });

  test("a card moved to in_progress by hand works only while the chat that opened it has a turn open", () => {
    const chat = topic("aaaaaaaa-1", "Chat madre");
    card({ status: "in_progress", chip: null, creatorTopic: "aaaaaaaa-1" });
    expect(read().get(MAC)).toMatchObject({ working: 0, idle: 1 });
    expect(read({ openChats: [[chat, NOW - 1000]] }).get(MAC)).toMatchObject({ working: 1, idle: 0 });
  });

  test("a review with a question, or a needs_input chip, waits for you; any other review is just in review", () => {
    card({ status: "review", chip: "delivered", ask: "Ok a vista sulla pagina?" });
    card({ status: "review", chip: "needs_input" });
    card({ status: "in_progress", chip: "needs_input" });
    card({ status: "review", chip: "delivered", ask: "   " });
    card({ status: "review", chip: null });
    expect(read().get(MAC)).toMatchObject({ waiting: 3, review: 2 });
  });

  test("a todo or in_progress card stopped on the plan limit is stuck; an agent's own wait is only queued", () => {
    card({ status: "todo", chip: "queued", error: "Claude: Claude quota exhausted. Ripresa dopo il reset delle 14:45." });
    card({ status: "in_progress", chip: "queued", error: "Codex: piano esaurito." });
    card({ status: "todo", chip: "waiting", error: "In attesa: reset della finestra di 5 ore di un altro account" });
    card({ status: "in_progress", chip: "queued", error: null, machine: CLOUD });
    const out = read();
    expect(out.get(MAC)).toMatchObject({ stuck: 2, queued: 1 });
    expect(out.get(CLOUD)).toMatchObject({ stuck: 0, queued: 1 });
  });
});

describe("projects and the listed items", () => {
  test("agents are grouped by their visible project, the biggest group first", () => {
    card({ status: "todo", project: LEDGER });
    card({ status: "in_progress", chip: "working", project: LEDGER });
    card({ status: "review", project: TOPICS });
    // A board with no registered folder is shown by its id without the hash, never as the bare id.
    card({ status: "todo", project: "inbox-mn52yh" });
    expect(read().get(MAC)!.byProject).toEqual([
      { project: "Ledger", count: 2 }, { project: "inbox", count: 1 }, { project: "Topics", count: 1 },
    ]);
  });

  test("items come in the order waiting, working, stuck, review, queued", () => {
    card({ status: "todo", text: "in coda" });
    card({ status: "review", text: "da guardare" });
    card({ status: "todo", chip: "queued", error: "Claude: finestra al 98%", text: "fermo sul limite" });
    card({ status: "in_progress", chip: "working", text: "al lavoro" });
    card({ status: "review", ask: "Ti va bene?", text: "aspetta te" });
    expect(read().get(MAC)!.items.map((i) => `${i.state}:${i.title}`)).toEqual([
      "waiting:aspetta te", "working:al lavoro", "stuck:fermo sul limite", "review:da guardare", "queued:in coda",
    ]);
  });

  test("a review older than 7 days is counted but not listed, and the list stops at 12", () => {
    card({ status: "review", text: "vecchia", reviewAt: iso(8 * D) });
    card({ status: "review", ask: "Vecchia domanda?", text: "vecchia con domanda", reviewAt: iso(9 * D) });
    card({ status: "review", text: "recente", reviewAt: iso(2 * D) });
    const a = read().get(MAC)!;
    expect(a.review).toBe(2);
    expect(a.waiting).toBe(1);
    expect(a.items.map((i) => i.title)).toEqual(["recente"]);
    for (let i = 0; i < 20; i++) card({ status: "todo" });
    const b = read().get(MAC)!;
    expect(b.queued).toBe(20);
    expect(b.items).toHaveLength(MAX_AGENT_ITEMS);
  });

  test("an item carries when it entered the state", () => {
    card({ status: "in_progress", chip: "working", inProgressAt: iso(2 * H) });
    expect(read().get(MAC)!.items[0]!.since).toBe(NOW - 2 * H);
  });
});

describe("chats", () => {
  test("an open turn is a chat of this machine, with its project; the session of a card is the card, not a chat", () => {
    const byPath = topic("bbbbbbbb-1", "Verifica com mai mi ha", { path: "/work/topics-app/sub" });
    const byWorktree = topic("cccccccc-1", "Rivedo le tabelle", { worktreeProject: "p-ledger" });
    const loose = topic("dddddddd-1", "Una domanda al volo");
    const owned = topic("eeeeeeee-1", "Sessione di una card");
    card({ status: "in_progress", chip: "working", assignedTopic: "eeeeeeee-1" });
    const out = read({ openChats: [[byPath, NOW - 5000], [byWorktree, null], [loose, NOW - 1000], [owned, NOW - 1000]] });
    const a = out.get(MAC)!;
    expect(a.chats).toBe(3);
    expect(a.working).toBe(1);
    expect(a.items.filter((i) => i.state === "chat").map((i) => `${i.title}|${i.project}`).sort()).toEqual([
      "Rivedo le tabelle|Ledger", "Una domanda al volo|Senza progetto", "Verifica com mai mi ha|Topics",
    ]);
    expect(out.get(PC)!.chats).toBe(0);
  });

  test("a chat parked on a question waits for you; an archived topic is nobody's agent", () => {
    const parked = topic("ffffffff-1", "Quale variante?");
    const gone = topic("11111111-1", "Chiusa", { archived: 1 });
    const a = read({ parked: [parked, gone] }).get(MAC)!;
    expect(a).toMatchObject({ waiting: 1, chats: 0 });
    expect(a.items[0]).toMatchObject({ state: "waiting", title: "Quale variante?" });
  });
});

describe("titles", () => {
  test("first line, no markup or leading emoji, cut on a word; never an id or a branch", () => {
    expect(shortTitle("#🟢 **Fatture**: emissione\nseconda riga", "x")).toBe("Fatture: emissione");
    const long = "Aggiornare la libreria di parsing dei documenti alla versione nuova e rimuovere il vecchio adattatore";
    const cut = shortTitle(long, "x");
    expect(cut.length).toBeLessThanOrEqual(65);
    expect(cut.endsWith("…")).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(shortTitle("topics/placid-specter", "Card senza titolo")).toBe("Card senza titolo");
    expect(shortTitle("6f1c2d3e-4a5b-6c7d", "Card senza titolo")).toBe("Card senza titolo");
    expect(shortTitle("", "Chat senza titolo")).toBe("Chat senza titolo");
  });
});
