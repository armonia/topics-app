/**
 * L'orchestratore, lato servizio.
 *
 * Due cose si provano qui, e sono le due che se cedono rendono la feature una
 * bugia invece che un difetto:
 *
 *  1. Lo snapshot dice gli stati VERI letti in quel momento — e cambia quando la
 *     board cambia. Uno snapshot che non segue è peggio di nessuno snapshot: il
 *     modello agisce con sicurezza sulla card sbagliata.
 *  2. Le due porte sono la STESSA sessione. Se divergessero, «ricorda cosa gli
 *     hai chiesto» varrebbe da una parte sola e nessuno se ne accorgerebbe
 *     finché non manca un pezzo di conversazione.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { createTaskService, projectIdForPath, type TaskService } from "./tasks";
import type { Topic } from "../types";
import {
  ORCHESTRATOR_MCP_POLICY,
  boardSnapshotContent,
  isOrchestratorTopic,
  orchestratorRolePrompt,
  orchestratorTopicName,
  orchestratorTurn,
  resolveOrchestratorSession,
  type OrchestratorSessionDeps,
} from "./orchestrator";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Un DB con lo schema VERO: lo snapshot legge dal servizio task, non da un mock. */
function migratedDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  const dir = join(REPO_ROOT, "server", "db", "migrations");
  for (const file of readdirSync(dir).filter((f) => /^\d+-.+\.sql$/.test(f)).sort()) {
    db.exec(readFileSync(join(dir, file), "utf-8"));
  }
  return db;
}

const PROJECT_PATH = "/tmp/progetti/topics-app";
const PROJECT_ID = projectIdForPath(PROJECT_PATH);

function snapshotDeps(svc: TaskService) {
  return { listTasks: (pid: string) => svc.list({ scope: "project", projectId: pid, rootsOnly: true }) };
}

// ────────────────────────────────────────────────────────────────────────────
// BARRA 1 — «a che punto siamo» si risponde LEGGENDO
// ────────────────────────────────────────────────────────────────────────────

describe("boardSnapshotContent", () => {
  test("una board con N card in stati diversi produce gli stati VERI, card per card", () => {
    const svc = createTaskService(migratedDb());
    const inProgress = svc.create({ projectId: PROJECT_ID, text: "Rifare il composer", status: "in_progress" });
    const review = svc.create({ projectId: PROJECT_ID, text: "Tab morte al reattach", status: "review" });
    const todo = svc.create({ projectId: PROJECT_ID, text: "Icone dei progetti", status: "todo", priority: 4 });
    const backlog = svc.create({ projectId: PROJECT_ID, text: "Ripulire i worktree", status: "backlog" });

    const snap = boardSnapshotContent(snapshotDeps(svc), PROJECT_ID);

    // L'id di ogni card c'è: è ciò che rende lo snapshot AGIBILE senza ri-listare.
    for (const t of [inProgress, review, todo, backlog]) expect(snap).toContain(t.id);
    // E ognuna sta sotto la SUA colonna, non sotto una qualunque.
    expect(sectionOf(snap, inProgress.id)).toBe("in_progress");
    expect(sectionOf(snap, review.id)).toBe("review");
    expect(sectionOf(snap, todo.id)).toBe("todo");
    expect(sectionOf(snap, backlog.id)).toBe("backlog");
    expect(snap).toContain("Icone dei progetti");
  });

  test("la card che si sposta si sposta anche nello snapshot (è una LETTURA, non un ricordo)", () => {
    const svc = createTaskService(migratedDb());
    const t = svc.create({ projectId: PROJECT_ID, text: "Una card sola", status: "todo" });
    expect(sectionOf(boardSnapshotContent(snapshotDeps(svc), PROJECT_ID), t.id)).toBe("todo");

    svc.update({ taskId: t.id, actor: "human", by: "test", patch: { status: "review" } });
    expect(sectionOf(boardSnapshotContent(snapshotDeps(svc), PROJECT_ID), t.id)).toBe("review");
  });

  test("i sottotask non sono card: restano fuori (la board mostra le radici)", () => {
    const svc = createTaskService(migratedDb());
    const parent = svc.create({ projectId: PROJECT_ID, text: "Il task vero", status: "todo" });
    const step = svc.create({ projectId: PROJECT_ID, text: "Uno step interno", parentTaskId: parent.id });
    const snap = boardSnapshotContent(snapshotDeps(svc), PROJECT_ID);
    expect(snap).toContain(parent.id);
    expect(snap).not.toContain(step.id);
    // Il conteggio degli step però si vede: è metà della risposta a «a che punto siamo».
    expect(snap).toContain("step 0/1");
  });

  test("`done` si conta, non si elenca: la storia intera del progetto a ogni turno non serve a nessuno", () => {
    const svc = createTaskService(migratedDb());
    const done = svc.create({ projectId: PROJECT_ID, text: "Roba già uscita", status: "review" });
    svc.update({ taskId: done.id, actor: "human", by: "test", patch: { status: "done" } });
    const snap = boardSnapshotContent(snapshotDeps(svc), PROJECT_ID);
    expect(snap).toContain("## done — 1");
    expect(snap).not.toContain(done.id);
  });

  test("una board vuota lo DICE (il vuoto è una risposta, non un errore di lettura)", () => {
    const svc = createTaskService(migratedDb());
    expect(boardSnapshotContent(snapshotDeps(svc), PROJECT_ID)).toContain("nessuna card");
  });

  test("l'elenco troncato si DICHIARA: un taglio muto sembra un «non c'è»", () => {
    const svc = createTaskService(migratedDb());
    for (let i = 0; i < 65; i++) svc.create({ projectId: PROJECT_ID, text: `card ${i}`, status: "todo" });
    const snap = boardSnapshotContent(snapshotDeps(svc), PROJECT_ID);
    expect(snap).toMatch(/altre 5 card non elencate/);
    expect(snap).toContain("list_tasks");
  });
});

/** Sotto quale intestazione `## <stato>` compare questa card. */
function sectionOf(snapshot: string, taskId: string): string | null {
  let current: string | null = null;
  for (const line of snapshot.split("\n")) {
    const header = line.match(/^## ([a-z_]+) —/);
    if (header) { current = header[1]; continue; }
    if (line.includes(taskId)) return current;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// BARRA 4 — stessa risposta dalle due porte
// ────────────────────────────────────────────────────────────────────────────

function fakeTopic(over: Partial<Topic> = {}): Topic {
  return {
    id: "t-orch", name: orchestratorTopicName("topics-app"), slug: "orch", parentId: null, links: [],
    sessionKey: "topic:orch1234", color: "#000", icon: "MessageSquare",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", archived: true,
    projectPath: PROJECT_PATH, mcpPolicy: ORCHESTRATOR_MCP_POLICY,
    ...over,
  } as Topic;
}

/** Il mondo minimo in cui vive `orchestratorTurn`: un indice di topic e una fabbrica. */
function sessionDeps(existing: Topic | null): { deps: OrchestratorSessionDeps; created: Topic[] } {
  const created: Topic[] = [];
  let store = existing;
  const deps: OrchestratorSessionDeps = {
    findOrchestratorTopic: (p) => (store && store.projectPath === p ? store : null),
    createTopic: (o) => {
      const t = fakeTopic({ id: `t-${created.length}`, sessionKey: `topic:new${created.length}`, name: o.name, projectPath: o.projectPath, systemPrompt: o.systemPrompt, mcpPolicy: o.mcpPolicy });
      created.push(t);
      store = t;
      return { topicId: t.id, sessionKey: t.sessionKey };
    },
  };
  return { deps, created };
}

const TARGET = { projectPath: PROJECT_PATH, projectName: "topics-app" };

describe("le due porte", () => {
  test("chat e composer, stesso input → stesso sessionKey e stesso contenuto", () => {
    const { deps } = sessionDeps(fakeTopic());
    const daChat = orchestratorTurn(deps, TARGET, "sposta le tre card di review in todo");
    const daComposer = orchestratorTurn(deps, TARGET, "sposta le tre card di review in todo");
    expect(daComposer.sessionKey).toBe(daChat.sessionKey);
    expect(daComposer.topicId).toBe(daChat.topicId);
    expect(daComposer.content).toBe(daChat.content);
  });

  test("la sessione è UNA per progetto: la seconda porta non ne fonda una seconda", () => {
    const { deps, created } = sessionDeps(null);
    const primo = orchestratorTurn(deps, TARGET, "a che punto siamo?");
    const secondo = orchestratorTurn(deps, TARGET, "e adesso?");
    expect(primo.created).toBe(true);
    expect(secondo.created).toBe(false);
    expect(secondo.sessionKey).toBe(primo.sessionKey);
    expect(created).toHaveLength(1);
  });

  test("la sessione nasce col ruolo e con la policy che le dà le mani giuste", () => {
    const { deps, created } = sessionDeps(null);
    resolveOrchestratorSession(deps, TARGET);
    expect(created[0].mcpPolicy).toBe(ORCHESTRATOR_MCP_POLICY);
    expect(created[0].systemPrompt).toBe(orchestratorRolePrompt("topics-app"));
    expect(isOrchestratorTopic(created[0])).toBe(true);
  });

  test("un topic qualunque NON è l'orchestratore (e non riceve lo stato della board)", () => {
    expect(isOrchestratorTopic(fakeTopic({ mcpPolicy: undefined }))).toBe(false);
    expect(isOrchestratorTopic(fakeTopic({ mcpPolicy: "bridge-only" }))).toBe(false);
    expect(isOrchestratorTopic(null)).toBe(false);
  });

  test("un messaggio vuoto non apre un turno da nessuna delle due porte", () => {
    const { deps } = sessionDeps(fakeTopic());
    expect(() => orchestratorTurn(deps, TARGET, "   ")).toThrow();
  });
});

describe("il ruolo", () => {
  test("dice le mani che ha e quelle che NON ha, e la regola del non-muto", () => {
    const prompt = orchestratorRolePrompt("topics-app");
    expect(prompt).toContain("list_tasks");
    expect(prompt).toContain("update_task");
    expect(prompt).toContain("sotto-agenti");
    expect(prompt).toContain("PROPONI");
  });
});
