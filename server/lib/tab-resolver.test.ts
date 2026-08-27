/**
 * @covers TABRES-01
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { projectPanesKey } from "../../shared/project-keys";
import { projectIdForPath } from "../services/tasks";
import { buildTabPath } from "../../shared/tab-link";
import {
  resolveTabRef,
  isAddressableProjectPath,
  projectDirOnDisk,
  type TabResolverDeps,
} from "./tab-resolver";
import { TASKS_DDL, TASK_LABELS_DDL } from "../db/test-schema";

// ── Un DB sintetico, con solo le colonne che il resolver legge ───────────────
// (stesso pattern di claude-session-repo.test.ts: schema minimo in :memory:,
// così il test dice quali colonne sono davvero il contratto).

const PROJ = "/Users/utente/Projects/topics-app";
const OTHER_PROJ = "/Users/utente/Projects/darkroom";

let db: Database;

function freshDb(): Database {
  const d = new Database(":memory:");
  d.run(`CREATE TABLE ui_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL,
    payload_version INTEGER NOT NULL DEFAULT 2, server_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  )`);
  d.run(`CREATE TABLE topics (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
    session_key TEXT NOT NULL, project_path TEXT, worktree_id TEXT
  )`);
  d.run(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
  )`);
  d.run(`CREATE TABLE worktrees (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, abs_path TEXT NOT NULL, status TEXT NOT NULL
  )`);
  d.run(TASKS_DDL);
  d.run(TASK_LABELS_DDL); // migration 100 — rowToTask la legge per OGNI task
  d.run(`CREATE TABLE terminal_sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, type TEXT NOT NULL,
    topic_id TEXT, status TEXT NOT NULL DEFAULT 'active'
  )`);
  return d;
}

function putUi(key: string, value: unknown, seq = 1): void {
  db.run("INSERT OR REPLACE INTO ui_state (key, value, payload_version, server_seq) VALUES (?, ?, 2, ?)", [
    key,
    JSON.stringify(value),
    seq,
  ]);
}

function deps(extra: Partial<TabResolverDeps> = {}): TabResolverDeps {
  return { db, ...extra };
}

beforeEach(() => {
  db = freshDb();
  db.run("INSERT INTO projects (id, name, path) VALUES ('p1', 'Topics App', ?)", [PROJ]);
  db.run("INSERT INTO projects (id, name, path) VALUES ('p2', 'Darkroom', ?)", [OTHER_PROJ]);
  db.run(
    "INSERT INTO topics (id, name, session_key, project_path) VALUES ('t-1', 'Bozza email Alessio Fulgione', 'topic:t-1', ?)",
    [PROJ],
  );
});

// ── La grammatica è la prima porta ───────────────────────────────────────────

describe("resolveTabRef — ref che non sono permalink", () => {
  test("null (non un errore) per un ref che la grammatica non riconosce", () => {
    for (const ref of ["", "   ", "/settings", "/assets/index.js", "https://example.com/foo", "ciao"]) {
      expect(resolveTabRef(ref, deps())).toBeNull();
    }
  });

  test("accetta sia un path nudo sia una URL assoluta", () => {
    const bare = resolveTabRef("/tab/chat/t-1", deps());
    const abs = resolveTabRef("http://127.0.0.1:3333/tab/chat/t-1", deps());
    expect(bare?.key).toBe("t-1");
    expect(abs).toEqual(bare!);
  });

  test("gli alias storici /task/<id> e /topic/<id> risolvono", () => {
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('k-1', 'Fai la cosa', 'todo', 'p-test', '2026-01-01', '2026-01-01')");
    expect(resolveTabRef("/task/k-1", deps())?.kind).toBe("task");
    expect(resolveTabRef("/topic/t-1", deps())?.kind).toBe("chat");
  });
});

// ── CHAT: il titolo viene dalla fonte, non dalla pane ────────────────────────

describe("resolveTabRef — chat", () => {
  test("pane viva a livello App: aperta, e il titolo è quello del TOPIC", () => {
    // La pane dice ancora «New Chat» — è lo stato reale sul DB vivo. Se il
    // resolver leggesse pane.title, l'agente riceverebbe un nome sbagliato.
    putUi("pane-store-v2", {
      panes: { "t-1": { id: "t-1", type: "chat", title: "New Chat", topicId: "t-1" } },
    });
    const r = resolveTabRef("/tab/chat/t-1", deps())!;
    expect(r.title).toBe("Bozza email Alessio Fulgione");
    expect(r.state).toBe("open");
    expect(r.surface).toBe("app");
    expect(r.pointers).toEqual({ topicId: "t-1", sessionKey: "topic:t-1", projectPath: PROJ, cwd: PROJ });
    expect(r.next).toEqual({ tool: "read_chat_messages", args: { topic_id: "t-1" } });
  });

  test("la stessa chat con l'id di pane `chat:<topicId>` conta lo stesso", () => {
    putUi("pane-store-v2", { panes: { "chat:t-1": { id: "chat:t-1", type: "chat", topicId: "t-1" } } });
    expect(resolveTabRef("/tab/chat/t-1", deps())!.state).toBe("open");
  });

  test("aperta DENTRO una finestra di progetto (openChatTopicIds, non una pane)", () => {
    // È la maggioranza dei casi reali: leggere solo `pane-store-v2` li perde.
    putUi("pane-store-v2", { panes: {} });
    putUi(projectPanesKey(PROJ), { nonChatPanes: [], openChatTopicIds: ["t-1"] });
    const r = resolveTabRef("/tab/chat/t-1", deps())!;
    expect(r.state).toBe("open");
    expect(r.surface).toBe(`project:${PROJ}`);
  });

  test("in closedStack: CHIUSA, anche se il record porta titolo e url", () => {
    putUi("pane-store-v2", {
      panes: {},
      closedStack: [
        { id: "t-1", closedAt: 1, pane: { id: "t-1", type: "chat", title: "New Chat", topicId: "t-1" }, projectPath: PROJ },
      ],
    });
    const r = resolveTabRef("/tab/chat/t-1", deps())!;
    expect(r.state).toBe("closed");
    expect(r.surface).toBe(`project:${PROJ}`);
    expect(r.title).toBe("Bozza email Alessio Fulgione");
  });

  test("un tombstone STANTÌO non chiude una pane viva", () => {
    // La pane è in `panes` E in `tombstones`: è stata riaperta dopo quella
    // chiusura. Le vive si guardano per prime, apposta.
    putUi("pane-store-v2", {
      panes: { "t-1": { id: "t-1", type: "chat", topicId: "t-1" } },
      tombstones: { "t-1": 123 },
    });
    expect(resolveTabRef("/tab/chat/t-1", deps())!.state).toBe("open");
  });

  test("solo tombstone ⇒ chiusa", () => {
    putUi("pane-store-v2", { panes: {}, tombstones: { "t-1": 123 } });
    expect(resolveTabRef("/tab/chat/t-1", deps())!.state).toBe("closed");
  });

  test("il topic esiste ma nessuna superficie lo mostra ⇒ chiusa", () => {
    expect(resolveTabRef("/tab/chat/t-1", deps())!.state).toBe("closed");
  });

  test("topic archiviato ⇒ archived, anche con la tab aperta", () => {
    db.run("UPDATE topics SET archived = 1 WHERE id = 't-1'");
    putUi("pane-store-v2", { panes: { "t-1": { id: "t-1", type: "chat", topicId: "t-1" } } });
    expect(resolveTabRef("/tab/chat/t-1", deps())!.state).toBe("archived");
  });

  test("topic inesistente ⇒ unknown, e il titolo NON viene inventato", () => {
    const r = resolveTabRef("/tab/chat/mai-esistito", deps())!;
    expect(r.state).toBe("unknown");
    expect(r.title).toBe("chat mai-esistito");
    // Il `next` resta utile comunque: è l'agente a scoprire se c'è o no.
    expect(r.next).toEqual({ tool: "read_chat_messages", args: { topic_id: "mai-esistito" } });
  });

  test("il cwd segue il worktree READY, non il projectPath", () => {
    db.run("INSERT INTO worktrees (id, name, abs_path, status) VALUES ('w1', 'feat', '/tmp/wt-feat', 'ready')");
    db.run("UPDATE topics SET worktree_id = 'w1' WHERE id = 't-1'");
    expect(resolveTabRef("/tab/chat/t-1", deps())!.pointers.cwd).toBe("/tmp/wt-feat");
    // Un worktree non pronto ricade sul progetto (stessa precedenza di resolveTopicCwd).
    db.run("UPDATE worktrees SET status = 'pending' WHERE id = 'w1'");
    expect(resolveTabRef("/tab/chat/t-1", deps())!.pointers.cwd).toBe(PROJ);
  });

  test("la funzione cwd iniettata ha la precedenza sul fallback SQL", () => {
    const r = resolveTabRef("/tab/chat/t-1", deps({ resolveCwdForTopic: () => "/iniettato" }))!;
    expect(r.pointers.cwd).toBe("/iniettato");
  });
});

// ── TERMINAL: roster vuoto ≠ sessione inesistente ────────────────────────────

describe("resolveTabRef — terminal", () => {
  test("pane viva con roster VUOTO: la tab resta aperta, il titolo è neutro", () => {
    // Sul DB vivo `terminal_sessions` è vuota mentre ui_state contiene ancora
    // decine di id `terminal:`. Un miss del roster non chiude la tab.
    putUi(projectPanesKey(PROJ), {
      nonChatPanes: [{ id: "terminal:s-9", type: "terminal", title: "Claude Code" }],
      openChatTopicIds: [],
    });
    const r = resolveTabRef("/tab/terminal/s-9", deps())!;
    expect(r.state).toBe("open");
    expect(r.surface).toBe(`project:${PROJ}`);
    expect(r.title).toBe("terminale s-9");
    expect(r.pointers.cwd).toBeUndefined();
  });

  test("con il roster: titolo e cwd vengono da lì, più il sessionKey del topic", () => {
    db.run(
      "INSERT INTO terminal_sessions (id, name, cwd, type, topic_id) VALUES ('s-9', 'Connettere hardware', ?, 'claude-code', 't-1')",
      [PROJ],
    );
    putUi("pane-store-v2", { panes: { "terminal:s-9": { id: "terminal:s-9", type: "terminal", title: "Claude Code" } } });
    const r = resolveTabRef("/tab/terminal/s-9", deps())!;
    expect(r.title).toBe("Connettere hardware");
    expect(r.pointers).toEqual({ cwd: PROJ, topicId: "t-1", sessionKey: "topic:t-1" });
    expect(r.next).toEqual({ tool: "GET /api/terminal/sessions/:id/buffer", args: { id: "s-9" } });
  });

  test("né pane né roster ⇒ unknown («sconosciuto», non «non esiste»)", () => {
    expect(resolveTabRef("/tab/terminal/s-mai", deps())!.state).toBe("unknown");
  });
});

// ── BROWSER: presenza in tre posti diversi ───────────────────────────────────

describe("resolveTabRef — browser", () => {
  test("dentro una finestra di progetto, e il titolo dal context VIVO", () => {
    putUi(projectPanesKey(OTHER_PROJ), {
      nonChatPanes: [{ id: "browser:c-1", type: "browser", title: "titolo vecchio", url: "http://vecchio" }],
      openChatTopicIds: [],
    });
    const r = resolveTabRef("/tab/browser/c-1", deps({
      listBrowserContexts: () => [{ id: "c-1", url: "http://localhost:3601/p/darkroom", title: "Darkroom" }],
    }))!;
    expect(r.state).toBe("open");
    expect(r.surface).toBe(`project:${OTHER_PROJ}`);
    expect(r.title).toBe("Darkroom");
    expect(r.next).toEqual({ tool: "browser_read_screen", args: { contextId: "c-1" } });
  });

  test("tab di un TASK: superficie task:<id>, titolo dall'inventario del task", () => {
    putUi("task-browser-tabs:k-1", {
      tabs: [{ contextId: "task-k1-0", url: "http://localhost:3200/login", title: "DemoApp" }],
      activeContextId: null,
    });
    const r = resolveTabRef("/tab/browser/task-k1-0", deps())!;
    expect(r.state).toBe("open");
    expect(r.surface).toBe("task:k-1");
    expect(r.title).toBe("DemoApp");
    expect(r.pointers).toEqual({ contextId: "task-k1-0", taskId: "k-1" });
  });

  test("presente nel layout di un task (paneIds) anche senza inventario", () => {
    putUi("task-browser-layout:k-2", {
      groups: [{ id: "g1", paneIds: ["thread:k-2", "browser:c-7"] }],
    });
    const r = resolveTabRef("/tab/browser/c-7", deps())!;
    expect(r.surface).toBe("task:k-2");
    expect(r.state).toBe("open");
  });

  test("pane nativa registrata (delegata) senza snapshot: viva lo stesso", () => {
    const r = resolveTabRef("/tab/browser/c-native", deps({ listDelegatedContextIds: () => ["c-native"] }))!;
    expect(r.state).toBe("open");
    expect(r.next).toEqual({ tool: "browser_read_screen", args: { contextId: "c-native" } });
  });

  test("nessuna traccia ⇒ unknown, e il passo successivo è browser_status", () => {
    const r = resolveTabRef("/tab/browser/c-ignoto", deps())!;
    expect(r.state).toBe("unknown");
    expect(r.next).toEqual({ tool: "browser_status", args: { contextId: "c-ignoto" } });
  });

  test("l'hint `?in=` finisce nei pointer e nella superficie", () => {
    const ref = buildTabPath({ kind: "browser", key: "c-3", projectPath: OTHER_PROJ })!;
    const r = resolveTabRef(ref, deps())!;
    expect(r.pointers.projectPath).toBe(OTHER_PROJ);
    expect(r.surface).toBe(`project:${OTHER_PROJ}`);
  });
});

// ── FILE / DIFF: si indirizza il CONTENUTO, non l'id ─────────────────────────

describe("resolveTabRef — file e diff", () => {
  const ABS = `${PROJ}/client/src/App.tsx`;

  test("la pane ha un id casuale: si trova per filePath, non per id", () => {
    putUi(projectPanesKey(PROJ), {
      nonChatPanes: [{ id: "file:9c0e1f4a-uuid-casuale", type: "file", filePath: ABS, title: "App.tsx" }],
      openChatTopicIds: [],
    });
    const ref = buildTabPath({ kind: "file", key: "client/src/App.tsx", projectPath: PROJ })!;
    const r = resolveTabRef(ref, deps())!;
    expect(r.state).toBe("open");
    expect(r.surface).toBe(`project:${PROJ}`);
    expect(r.title).toBe("App.tsx");
    expect(r.pointers).toEqual({ filePath: ABS, projectPath: PROJ, cwd: PROJ });
    expect(r.next).toEqual({ tool: "Read", args: { file_path: ABS } });
  });

  test("diff e file sono DUE tab distinte sullo stesso path", () => {
    // La vista diff è la stessa pane con `diff: true`. Un link /tab/file non
    // deve dichiararsi aperto perché è aperta la diff, e viceversa.
    putUi(projectPanesKey(PROJ), {
      nonChatPanes: [
        { id: "diff:client/src/App.tsx", type: "file", filePath: ABS, diff: true, diffProjectPath: PROJ },
      ],
      openChatTopicIds: [],
    });
    const fileRef = buildTabPath({ kind: "file", key: "client/src/App.tsx", projectPath: PROJ })!;
    const diffRef = buildTabPath({ kind: "diff", key: "client/src/App.tsx", projectPath: PROJ })!;
    expect(resolveTabRef(fileRef, deps())!.state).toBe("closed");
    expect(resolveTabRef(diffRef, deps())!.state).toBe("open");
  });

  test("senza tab aperta: closed, mai unknown (il path è il soggetto)", () => {
    const ref = buildTabPath({ kind: "file", key: "README.md", projectPath: PROJ })!;
    const r = resolveTabRef(ref, deps())!;
    expect(r.state).toBe("closed");
    expect(r.pointers.filePath).toBe(`${PROJ}/README.md`);
  });

  test("un path di progetto con un PUNTO sopravvive al giro completo", () => {
    const weird = "/Users/utente/Projects/my.app";
    const ref = buildTabPath({ kind: "file", key: "src/main.ts", projectPath: weird })!;
    expect(ref).not.toContain(".");
    const r = resolveTabRef(`http://127.0.0.1:3333${ref}`, deps())!;
    expect(r.pointers.filePath).toBe(`${weird}/src/main.ts`);
  });
});

// ── PROJECT, PANEL, TASK ─────────────────────────────────────────────────────

describe("resolveTabRef — project", () => {
  test("finestra aperta: titolo dal registro dei progetti, next = il cwd", () => {
    putUi("pane-store-v2", {
      panes: { [`project:${encodeURIComponent(PROJ)}`]: { id: `project:${encodeURIComponent(PROJ)}`, type: "project", projectPath: PROJ } },
    });
    const ref = buildTabPath({ kind: "project", key: PROJ })!;
    const r = resolveTabRef(ref, deps())!;
    expect(r.state).toBe("open");
    expect(r.title).toBe("Topics App");
    expect(r.pointers).toEqual({ projectPath: PROJ, cwd: PROJ });
    expect(r.next).toEqual({ tool: "Bash", args: { cwd: PROJ } });
  });

  test("progetto noto ma finestra chiusa ⇒ closed; path ignoto ⇒ unknown", () => {
    expect(resolveTabRef(buildTabPath({ kind: "project", key: PROJ })!, deps())!.state).toBe("closed");
    const ignoto = resolveTabRef(buildTabPath({ kind: "project", key: "/tmp/mai-visto" })!, deps())!;
    expect(ignoto.state).toBe("unknown");
    expect(ignoto.title).toBe("mai-visto");
  });
});

describe("resolveTabRef — panel", () => {
  test("il pannello aperto è la pane `__<nome>__`", () => {
    putUi("pane-store-v2", { panes: { __board__: { id: "__board__", type: "board", title: "Board generale" } } });
    const r = resolveTabRef("/tab/panel/board", deps())!;
    expect(r.state).toBe("open");
    expect(r.next).toEqual({ tool: "list_tasks", args: {} });
    expect(resolveTabRef("/tab/panel/cron", deps())!.state).toBe("closed");
  });

  test("`journal` non è un panel emettibile: la grammatica lo rifiuta", () => {
    expect(resolveTabRef("/tab/panel/journal", deps())).toBeNull();
  });
});

describe("resolveTabRef — task", () => {
  test("`tasks.project_id` è l'id di BOARD, non `projects.id`", () => {
    // Il join ingenuo su projects.id non trova NULLA: sul DB vivo il task del
    // board DemoApp porta `demoapp-v1skoz`. Si ricalcola l'id sui path noti.
    const boardId = projectIdForPath(PROJ);
    expect(boardId).not.toBe("p1");
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('k-1', 'Permalink alle tab', 'review', ?, '2026-01-01', '2026-01-01')", [boardId]);
    putUi("task-browser-layout:k-1", { groups: [] });
    const r = resolveTabRef("/tab/task/k-1", deps())!;
    expect(r.title).toBe("Permalink alle tab");
    expect(r.state).toBe("open");
    expect(r.surface).toBe("task:k-1");
    expect(r.pointers).toEqual({ taskId: "k-1", projectPath: PROJ, cwd: PROJ });
    expect(r.next).toEqual({ tool: "get_task", args: { task_id: "k-1" } });
  });

  test("la forma legacy (project_id = projects.id) continua a risolvere", () => {
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('k-3', 'Vecchio schema', 'todo', 'p1', '2026-01-01', '2026-01-01')");
    expect(resolveTabRef("/tab/task/k-3", deps())!.pointers.projectPath).toBe(PROJ);
  });

  test("un project_id speciale (`_none`) non produce un path inventato", () => {
    db.run("INSERT INTO tasks (id, text, status, project_id, created_at, updated_at) VALUES ('k-4', 'Senza progetto', 'todo', '_none', '2026-01-01', '2026-01-01')");
    const r = resolveTabRef("/tab/task/k-4", deps())!;
    expect(r.pointers.projectPath).toBeUndefined();
    expect(r.pointers.cwd).toBeUndefined();
  });

  test("il cwd di un task dispatchato è il WORKTREE del suo topic", () => {
    db.run("INSERT INTO worktrees (id, name, abs_path, status) VALUES ('w9', 'task-wt', '/tmp/wt-task', 'ready')");
    db.run("UPDATE topics SET worktree_id = 'w9' WHERE id = 't-1'");
    db.run(
      "INSERT INTO tasks (id, text, status, project_id, assigned_topic_id, created_at, updated_at) VALUES ('k-5', 'Dispatchato', 'in_progress', ?, 't-1', '2026-01-01', '2026-01-01')",
      [projectIdForPath(PROJ)],
    );
    const r = resolveTabRef("/tab/task/k-5", deps())!;
    expect(r.pointers.cwd).toBe("/tmp/wt-task");
    expect(r.pointers.projectPath).toBe(PROJ);
    expect(r.pointers.sessionKey).toBe("topic:t-1");
  });

  test("task archiviato ⇒ archived; task inesistente ⇒ unknown", () => {
    db.run("INSERT INTO tasks (id, text, status, archived, project_id, created_at, updated_at) VALUES ('k-2', 'Vecchio', 'done', 1, 'p-test', '2026-01-01', '2026-01-01')");
    expect(resolveTabRef("/tab/task/k-2", deps())!.state).toBe("archived");
    expect(resolveTabRef("/tab/task/k-ignoto", deps())!.state).toBe("unknown");
  });
});

// ── Il DISCO, per i soggetti che il server non registra ─────────────────────
//
// Il difetto che questo blocco fissa: l'app apre finestre di progetto senza
// scrivere NIENTE sul server (`handleProjectClick`: ensurePaneRegistered +
// `recent-projects` su localStorage), e alla chiusura `PURGE_ORPHAN_PANE` non
// lascia né closedStack né tombstone. Una cartella aperta col picker e poi
// chiusa non è quindi in `projects`, non è in `worktrees`, non è in `ui_state`:
// dichiararla `unknown` faceva rifiutare al client un permalink LEGITTIMO —
// «Copia link» sulla tab, chiudi la tab, riclicca il link, non succede niente.
// Le chat e i task restano server-autoritativi: lì `unknown` vuol dire davvero
// «chiave inventata», ed è il ramo che deve continuare a rifiutare.

describe("resolveTabRef — project/file esistono se la CARTELLA esiste", () => {
  // Una directory VERA, non un mock: il criterio è il filesystem, e un fake
  // proverebbe solo che il fake funziona. `mkdtemp` la rende indipendente
  // dalla macchina (su CI `/Users/utente/...` non esiste).
  const scratch = mkdtempSync(join(tmpdir(), "tabresolve-"));
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

  test("cartella sul disco ma sconosciuta a ogni tabella ⇒ closed, NON unknown", () => {
    // Nessuna riga in projects/worktrees, nessuna pane in ui_state: è esattamente
    // lo stato che lascia un progetto aperto col picker e poi chiuso.
    expect(db.query("SELECT 1 FROM projects WHERE path = ?").get(scratch)).toBeNull();
    const r = resolveTabRef(buildTabPath({ kind: "project", key: scratch })!, deps())!;
    expect(r.state).toBe("closed");
    expect(r.title).toBe(basename(scratch));
  });

  test("cartella che NON esiste ⇒ unknown (è il caso che il client deve rifiutare)", () => {
    const gone = `${scratch}/non-esiste-affatto`;
    expect(resolveTabRef(buildTabPath({ kind: "project", key: gone })!, deps())!.state).toBe("unknown");
  });

  test("un FILE non è un progetto: solo una directory conta", () => {
    const f = join(scratch, "un-file.txt");
    writeFileSync(f, "x");
    expect(resolveTabRef(buildTabPath({ kind: "project", key: f })!, deps())!.state).toBe("unknown");
  });

  test("/tab/file dentro una cartella che esiste ⇒ closed; dentro una che non c'è ⇒ unknown", () => {
    // Il client per un file chiede al server il ref del PROGETTO ospite, quindi
    // i due devono rispondere la stessa cosa: qui si fissa che lo facciano.
    const vivo = buildTabPath({ kind: "file", key: "src/a.ts", projectPath: scratch })!;
    const morto = buildTabPath({ kind: "file", key: "src/a.ts", projectPath: `${scratch}/mai-esistito` })!;
    expect(resolveTabRef(vivo, deps())!.state).toBe("closed");
    expect(resolveTabRef(morto, deps())!.state).toBe("unknown");
    expect(resolveTabRef(morto.replace("/tab/file/", "/tab/diff/"), deps())!.state).toBe("unknown");
  });

  test("un progetto REGISTRATO resta noto anche se la cartella non è montata", () => {
    // Un volume esterno staccato, un worktree ancora da creare: il DB è una
    // fonte a sé, e chiudere quel link sarebbe una regressione a sua volta.
    db.run("INSERT INTO projects (id, name, path) VALUES ('p9', 'Su disco esterno', '/Volumes/Nope/prog')");
    expect(resolveTabRef(buildTabPath({ kind: "project", key: "/Volumes/Nope/prog" })!, deps())!.state)
      .toBe("closed");
    expect(resolveTabRef(buildTabPath({ kind: "file", key: "a.ts", projectPath: "/Volumes/Nope/prog" })!, deps())!.state)
      .toBe("closed");
  });

  test("una CHAT inventata continua a essere rifiutata: la guardia è asimmetrica", () => {
    // La correzione non deve diventare «tutto esiste»: `topics` è una tabella,
    // e un UUID che non c'è è una chiave inventata.
    expect(resolveTabRef("/tab/chat/123e4567-e89b-12d3-a456-426614174000", deps())!.state).toBe("unknown");
    expect(resolveTabRef("/tab/task/k-inventato", deps())!.state).toBe("unknown");
  });
});

describe("il perimetro della stat: quali stringhe hanno diritto a diventare una domanda al filesystem", () => {
  test("passa solo un path assoluto e GIÀ NORMALIZZATO", () => {
    expect(isAddressableProjectPath("/Users/x/proj")).toBe(true);
    expect(isAddressableProjectPath("/Users/x/proj/")).toBe(true); // un trailing slash è tollerato
    expect(isAddressableProjectPath("/")).toBe(true);
  });

  test("la traversata non diventa mai una stat", () => {
    for (const bad of [
      "/Users/x/../../etc",
      "/Users/x/./proj",
      "/Users//x/proj",
      "../etc/passwd",
      "relativo/proj",
      "",
      "   ",
      "/Users/x\0/proj",
      "/" + "a".repeat(5000),
    ]) {
      expect(isAddressableProjectPath(bad)).toBe(false);
      // …e il predicato di esistenza si ferma prima di toccare il disco.
      expect(projectDirOnDisk(bad)).toBe(false);
    }
  });

  test("un ref con `..` non risolve mai in `closed`, nemmeno se il path risolto esiste", () => {
    // Il `..` deve risolvere in una directory che ESISTE DAVVERO, o il test è
    // verde per il motivo sbagliato: con un bersaglio inesistente la stat
    // fallirebbe comunque e `unknown` uscirebbe anche senza la guardia — cioè
    // un'asserzione che non può fallire. `/private/etc` esiste su macOS (ed è
    // dove `/etc` punta), quindi qui a fermare la risposta è SOLO la guardia
    // sulla traversata.
    const real = mkdtempSync(join(tmpdir(), "tab-traversal-"));
    const traversal = `${real}/../${basename(real)}`; // risolve esattamente in `real`
    expect(existsSync(resolve(traversal))).toBe(true); // la premessa del test
    expect(resolve(traversal)).toBe(resolve(real));
    const ref = buildTabPath({ kind: "project", key: traversal })!;
    expect(resolveTabRef(ref, deps())!.state).toBe("unknown");
  });
});

// ── L'hash djb2 non è una prova ──────────────────────────────────────────────

describe("resolveTabRef — la chiave di progetto non si prende per buona", () => {
  test("una riga il cui hash non inverte su nessun path noto esce come `project:#<hash>`", () => {
    // Succede quando il progetto è stato rimosso dal registro ma la sua riga
    // ui_state è sopravvissuta. Dire `project:/qualcosa` sarebbe inventare.
    putUi("topics-project-panes-zzzz9", {
      nonChatPanes: [{ id: "browser:c-orfano", type: "browser" }],
      openChatTopicIds: [],
    });
    const r = resolveTabRef("/tab/browser/c-orfano", deps())!;
    expect(r.state).toBe("open");
    expect(r.surface).toBe("project:#zzzz9");
    // Il pointer resta ASSENTE invece di essere sbagliato.
    expect(r.pointers.projectPath).toBeUndefined();
  });

  test("una collisione REALE esiste, e il path che il link porta con sé disambigua", () => {
    // djb2 qui è `h*31 + c` a 32 bit: due suffissi che collidono si scrivono a
    // mano ("Aa" e "BB" — 65*31+97 = 66*31+66). Non è un'ipotesi teorica, è la
    // collisione che il commento di shared/project-keys.ts accetta per scelta.
    const A = "/Users/x/proj-Aa";
    const B = "/Users/x/proj-BB";
    const key = projectPanesKey(A);
    expect(projectPanesKey(B)).toBe(key);

    db.run("INSERT INTO projects (id, name, path) VALUES ('pA', 'A', ?)", [A]);
    db.run("INSERT INTO projects (id, name, path) VALUES ('pB', 'B', ?)", [B]);
    putUi(key, { nonChatPanes: [{ id: "browser:c-9", type: "browser" }], openChatTopicIds: [] });

    // Senza hint: due candidati, nessuno dei due dimostrabile → non si nomina.
    const withoutHint = resolveTabRef("/tab/browser/c-9", deps())!;
    expect(withoutHint.surface).toBe(`project:#${key.slice("topics-project-panes-".length)}`);
    expect(withoutHint.state).toBe("open");

    // Con l'hint del link: vince quello, ed è verificato contro i candidati.
    const conHint = resolveTabRef(buildTabPath({ kind: "browser", key: "c-9", projectPath: B })!, deps())!;
    expect(conHint.surface).toBe(`project:${B}`);
  });
});

// ── SOLA LETTURA ─────────────────────────────────────────────────────────────

describe("resolveTabRef — non scrive MAI", () => {
  test("nessuna riga ui_state cambia (né valore né server_seq) dopo N resolve", () => {
    // Una scrittura dal server prenderebbe un server_seq più alto di ogni
    // client vivo e riporterebbe indietro tutte le finestre di tutti i
    // dispositivi. È il guasto che il gate CAS di ui-state esiste per impedire.
    putUi("pane-store-v2", { panes: { "t-1": { id: "t-1", type: "chat", topicId: "t-1" } } }, 41);
    putUi(projectPanesKey(PROJ), { nonChatPanes: [{ id: "browser:c-1", type: "browser" }] }, 42);
    putUi("task-browser-tabs:k-1", { tabs: [{ contextId: "task-k1-0", url: "u", title: "t" }] }, 43);
    const before = db.query("SELECT key, value, server_seq FROM ui_state ORDER BY key").all();

    for (const ref of [
      "/tab/chat/t-1",
      "/tab/browser/c-1",
      "/tab/browser/task-k1-0",
      "/tab/terminal/s-9",
      "/tab/panel/board",
      "/tab/task/k-1",
      buildTabPath({ kind: "file", key: "a.ts", projectPath: PROJ })!,
      buildTabPath({ kind: "project", key: PROJ })!,
    ]) {
      resolveTabRef(ref, deps());
    }

    expect(db.query("SELECT key, value, server_seq FROM ui_state ORDER BY key").all()).toEqual(before);
  });
});

// ── Nessuna tabella è obbligatoria ───────────────────────────────────────────

describe("resolveTabRef — degrada, non esplode", () => {
  test("un DB senza nessuna delle tabelle risponde `unknown` invece di lanciare", () => {
    const bare = new Database(":memory:");
    const r = resolveTabRef("/tab/chat/t-1", { db: bare })!;
    expect(r.state).toBe("unknown");
    expect(r.surface).toBe("app");
    expect(r.next).toEqual({ tool: "read_chat_messages", args: { topic_id: "t-1" } });
  });
});
