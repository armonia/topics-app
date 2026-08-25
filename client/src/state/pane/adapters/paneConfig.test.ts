/**
 * @covers PANE-02
 */
import { describe, test, expect } from "bun:test";
import type { Pane } from "../../../types";
import {
  createPaneId,
  createDraftPaneId,
  createGroupId,
  getAddableTypesForScope,
  getPaneConfig,
  isUUIDLike,
  isKnownPanePrefix,
  isDraftPaneId,
  isProjectPaneId,
  isTaskWorkspacePath,
  isBrowserPaneId,
  isTerminalPaneId,
  getProjectPathFromPaneId,
  getBrowserContextFromPaneId,
  getTerminalSessionFromPaneId,
  sessionKeyForPaneId,
  pinKeyForPane,
  normalizePinKey,
  tabTargetForPane,
} from "./paneConfig";
import { utilityPanelId } from "./utilityPanelId";

describe("createPaneId — per-type branching", () => {
  test("chat with a key builds a stable chat:<key> id (no random suffix)", () => {
    expect(createPaneId("chat", "topic-123")).toBe("chat:topic-123");
  });

  test("project with a key URL-encodes the key (path separators, spaces)", () => {
    expect(createPaneId("project", "/Users/a b/proj")).toBe(
      `project:${encodeURIComponent("/Users/a b/proj")}`,
    );
  });

  test("browser with a key builds browser:<key> verbatim (no encoding)", () => {
    expect(createPaneId("browser", "ctx-abc")).toBe("browser:ctx-abc");
  });

  test("terminal with a key builds terminal:<key> verbatim", () => {
    expect(createPaneId("terminal", "sess-xyz")).toBe("terminal:sess-xyz");
  });

  test("chat WITHOUT a key falls through to the generic <type>:<uuid> branch", () => {
    const id = createPaneId("chat");
    expect(id.startsWith("chat:")).toBe(true);
    expect(isUUIDLike(id.slice("chat:".length))).toBe(true);
  });

  test("a type with no dedicated branch (e.g. 'file') always gets a fresh uuid", () => {
    const a = createPaneId("file");
    const b = createPaneId("file");
    expect(a.startsWith("file:")).toBe(true);
    expect(a).not.toBe(b); // two calls must not collide
  });
});

describe("createDraftPaneId / createGroupId", () => {
  test("draft ids are prefixed and recognised by isDraftPaneId", () => {
    const id = createDraftPaneId();
    expect(id.startsWith("draft:")).toBe(true);
    expect(isDraftPaneId(id)).toBe(true);
    expect(isDraftPaneId("chat:not-a-draft")).toBe(false);
  });

  test("group ids are monotonically distinct across calls", () => {
    const a = createGroupId();
    const b = createGroupId();
    expect(a).not.toBe(b);
    expect(a.startsWith("group:")).toBe(true);
  });
});

describe("pane-id prefix predicates + extractors round-trip", () => {
  test("project: is* predicate + path extractor decode round-trip", () => {
    const id = createPaneId("project", "/work/demoapp");
    expect(isProjectPaneId(id)).toBe(true);
    expect(isBrowserPaneId(id)).toBe(false);
    expect(getProjectPathFromPaneId(id)).toBe("/work/demoapp");
  });

  test("browser: is* predicate + context extractor round-trip", () => {
    const id = createPaneId("browser", "ctx-42");
    expect(isBrowserPaneId(id)).toBe(true);
    expect(getBrowserContextFromPaneId(id)).toBe("ctx-42");
    expect(getBrowserContextFromPaneId("terminal:foo")).toBeNull();
  });

  test("isTaskWorkspacePath: only …/workspace/tasks/<id> paths, not real projects", () => {
    expect(isTaskWorkspacePath("/Users/x/.openclaw/workspace/tasks/92a1091a")).toBe(true);
    expect(isTaskWorkspacePath("/Users/x/.openclaw/workspace/tasks/92a1091a/")).toBe(true);
    // Real projects and the shared catch-all dir are NOT task workspaces.
    expect(isTaskWorkspacePath("/Users/x/Projects/alpha")).toBe(false);
    expect(isTaskWorkspacePath("/Users/x/.openclaw/workspace/generale")).toBe(false);
    // A deeper path inside a task dir is not the workspace root itself.
    expect(isTaskWorkspacePath("/Users/x/.openclaw/workspace/tasks/92a1091a/src")).toBe(false);
    expect(isTaskWorkspacePath(null)).toBe(false);
    expect(isTaskWorkspacePath(undefined)).toBe(false);
  });

  test("terminal: is* predicate + session extractor round-trip", () => {
    const id = createPaneId("terminal", "sess-7");
    expect(isTerminalPaneId(id)).toBe(true);
    expect(getTerminalSessionFromPaneId(id)).toBe("sess-7");
    expect(getTerminalSessionFromPaneId("browser:foo")).toBeNull();
  });

  test("sessionKeyForPaneId: la chat NON ha la sessionKey nell'id — va presa dal topic", () => {
    const topicId = "7b1e2a1f-2cf2-453c-a77b-5dc95d66e890";
    const topics = { [topicId]: { sessionKey: "topic:7b1e2a1f" } };
    // Pane di primo livello: l'id è il topic nudo.
    expect(sessionKeyForPaneId(topicId, topics)).toBe("topic:7b1e2a1f");
    // Dentro una finestra di progetto: `chat:<topicId>`.
    expect(sessionKeyForPaneId(createPaneId("chat", topicId), topics)).toBe("topic:7b1e2a1f");
  });

  test("sessionKeyForPaneId: niente sessione per i pane che non sono chat", () => {
    const topics = { t1: { sessionKey: "topic:t1" } };
    for (const id of ["terminal:s1", "browser:c1", "project:%2Ftmp", "draft:d1", "process-log:p1"]) {
      expect(sessionKeyForPaneId(id, topics)).toBeNull();
    }
    // Topic sconosciuto (chiuso, non ancora caricato): null, non l'id nudo —
    // era proprio l'id nudo a farsi passare per sessionKey.
    expect(sessionKeyForPaneId("ignoto", topics)).toBeNull();
    expect(sessionKeyForPaneId(null, topics)).toBeNull();
    expect(sessionKeyForPaneId(undefined, topics)).toBeNull();
  });

  test("isKnownPanePrefix recognises every documented prefix and rejects an unknown one", () => {
    for (const id of ["project:x", "browser:x", "terminal:x", "draft:x", "chat:x", "process-log:x", "__internal"]) {
      expect(isKnownPanePrefix(id)).toBe(true);
    }
    expect(isKnownPanePrefix("bogus:x")).toBe(false);
  });
});

describe("isUUIDLike", () => {
  test("accepts a canonical v4-shaped uuid (case-insensitive)", () => {
    expect(isUUIDLike("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isUUIDLike("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
  });

  test("rejects non-uuid strings, including a plain session/topic id", () => {
    expect(isUUIDLike("topic-123")).toBe(false);
    expect(isUUIDLike("")).toBe(false);
    expect(isUUIDLike("123e4567-e89b-12d3-a456-42661417400")).toBe(false); // one digit short
  });
});

describe("getAddableTypesForScope — scope + singleton filtering", () => {
  test("'standalone' scope excludes project-only types (files, git)", () => {
    const types = getAddableTypesForScope("standalone");
    expect(types).toContain("browser");
    expect(types).toContain("terminal");
    expect(types).not.toContain("files");
    expect(types).not.toContain("git");
  });

  test("'project' scope includes the project-only singleton types", () => {
    const types = getAddableTypesForScope("project");
    expect(types).toContain("files");
    expect(types).toContain("git");
    expect(types).toContain("browser");
    expect(types).toContain("terminal");
  });

  test("'chat' is never surfaced in either scope (dedicated onNewChat affordance)", () => {
    expect(getAddableTypesForScope("standalone")).not.toContain("chat");
    expect(getAddableTypesForScope("project")).not.toContain("chat");
  });

  test("a singleton type already present is excluded via excludeSingletonsPresent", () => {
    const withoutFiles = getAddableTypesForScope("project", new Set(["files"]));
    expect(withoutFiles).not.toContain("files");
    // A non-singleton type in the exclusion set is unaffected (exclusion only
    // applies when config.singleton is true).
    const withBrowserExcluded = getAddableTypesForScope("project", new Set(["browser"]));
    expect(withBrowserExcluded).toContain("browser");
  });

  test("Dashboard e Cron sono nel «+» standalone, non solo in un dropdown", () => {
    // Prima esistevano SOLO nel menu «Topics ▾», con nomi propri di quel menu
    // («Statistics», «Cron Jobs») e senza passare da qui. `addableScopes` è
    // l'unica cosa che serve per farle comparire ovunque si costruisca un
    // menu di creazione — questo test è il cancello di quella promessa.
    const types = getAddableTypesForScope("standalone", new Set(), new Set(["openclaw"]));
    expect(types).toContain("dashboard");
    expect(types).toContain("cron");
    // Restano fuori dallo scope progetto: sono pagine dell'APP, non del
    // progetto — una finestra di progetto non le ha mai offerte.
    const projectTypes = getAddableTypesForScope("project", new Set(), new Set(["openclaw"]));
    expect(projectTypes).not.toContain("dashboard");
    expect(projectTypes).not.toContain("cron");
  });

  test("Cron sparisce senza OpenClaw: il gate è del TIPO, non della superficie", () => {
    // Il filtro viveva scritto a mano nel dropdown. Se si perdesse, Cron
    // comparirebbe nel «+» anche dove OpenClaw non c'è e aprirebbe una pane
    // vuota. L'insieme di capacità VUOTO è anche il default all'avvio.
    const senza = getAddableTypesForScope("standalone", new Set(), new Set());
    expect(senza).not.toContain("cron");
    // Solo Cron: la Dashboard non dipende da OpenClaw (legge le API di Topics).
    expect(senza).toContain("dashboard");
  });

  test("fixed panes never appear regardless of scope", () => {
    // No shipped config currently sets `fixed`, so this asserts the invariant
    // holds for the full addable set rather than any single named type.
    const types = [...getAddableTypesForScope("standalone"), ...getAddableTypesForScope("project")];
    for (const t of types) {
      expect(getPaneConfig(t).fixed).not.toBe(true);
    }
  });
});

describe("pinKeyForPane — one canonical pin key per tab type", () => {
  const pane = (p: Partial<Pane> & { id: string; type: Pane["type"] }): Pane => p as Pane;

  test("chat → the bare topicId (NOT the chat:<id> pane id)", () => {
    expect(pinKeyForPane(pane({ id: createPaneId("chat", "topic-9"), type: "chat", topicId: "topic-9" }))).toBe("topic-9");
  });

  test("terminal → the terminal:<sessionId> pane id verbatim", () => {
    const id = createPaneId("terminal", "sess-7");
    expect(pinKeyForPane(pane({ id, type: "terminal" }))).toBe(id);
  });

  test("browser → the browser:<contextId> pane id verbatim (the regression this fixes)", () => {
    const id = createPaneId("browser", "ctx-42");
    expect(pinKeyForPane(pane({ id, type: "browser" }))).toBe(id);
  });

  // Cambiato di proposito: prima questo test asseriva `pane.id` (la forma
  // CODIFICATA), cioè fissava nel contratto il bug che la sidebar non trovava
  // mai il progetto fissato da una tab. La chiave canonica è la forma grezza,
  // l'unica che entrambe le superfici sanno produrre.
  test("project → project:<rawPath>, NON il pane id codificato", () => {
    const id = createPaneId("project", "/work/x");
    expect(id).toBe("project:%2Fwork%2Fx");
    expect(pinKeyForPane(pane({ id, type: "project" }))).toBe("project:/work/x");
  });

  test("le due superfici producono la STESSA chiave per lo stesso progetto", () => {
    const fromTab = pinKeyForPane(pane({ id: createPaneId("project", "/work/x"), type: "project" }));
    const fromSidebar = "project:/work/x"; // buildSidebarItems chiave la riga così
    expect(fromTab).toBe(fromSidebar);
  });

  test("chat with no topicId, and non-pinnable ephemeral types, return undefined", () => {
    expect(pinKeyForPane(pane({ id: "chat:x", type: "chat" }))).toBeUndefined();
    for (const type of ["file", "git", "activity", "journal", "agents", "dashboard"] as Pane["type"][]) {
      expect(pinKeyForPane(pane({ id: `${type}:x`, type }))).toBeUndefined();
    }
  });
});

describe("normalizePinKey — una sola forma per progetto", () => {
  test("la forma codificata torna grezza", () => {
    expect(normalizePinKey("project:%2FUsers%2Futente%2FProjects%2Ftopics-app"))
      .toBe("project:/Users/utente/Projects/topics-app");
  });

  test("è idempotente: applicarla due volte non cambia nulla", () => {
    const once = normalizePinKey("project:%2Fwork%2Fx");
    expect(normalizePinKey(once)).toBe(once);
    expect(once).toBe("project:/work/x");
  });

  test("le chiavi non-progetto passano intatte", () => {
    for (const key of ["topic-9", "terminal:sess-7", "browser:ctx-42", "__board__"]) {
      expect(normalizePinKey(key)).toBe(key);
    }
  });

  test("un path con un % non decodificabile resta com'è invece di far esplodere", () => {
    expect(normalizePinKey("project:/work/100%sicuro")).toBe("project:/work/100%sicuro");
  });
});

describe("tabTargetForPane — un permalink per tab, o NIENTE", () => {
  const pane = (p: Partial<Pane> & { id: string; type: Pane["type"] }): Pane => p as Pane;

  test("chat → il TOPIC, da entrambe le superfici (l'id della pane cambia, il topic no)", () => {
    const topicId = "topic-9";
    // A livello App l'id è il topic nudo; dentro un progetto è `chat:<topicId>`.
    expect(tabTargetForPane(pane({ id: topicId, type: "chat", topicId })))
      .toEqual({ kind: "chat", key: topicId });
    expect(tabTargetForPane(pane({ id: createPaneId("chat", topicId), type: "chat", topicId })))
      .toEqual({ kind: "chat", key: topicId });
  });

  test("chat senza topicId (bozza) → null: non c'è ancora niente da indirizzare", () => {
    expect(tabTargetForPane(pane({ id: createDraftPaneId(), type: "chat" }))).toBeNull();
  });

  test("terminal → la sessione, dall'id o dal campo per i pane legacy", () => {
    expect(tabTargetForPane(pane({ id: createPaneId("terminal", "sess-7"), type: "terminal" })))
      .toEqual({ kind: "terminal", key: "sess-7" });
    expect(tabTargetForPane(pane({ id: "terminal-legacy", type: "terminal", terminalSessionId: "sess-8" })))
      .toEqual({ kind: "terminal", key: "sess-8" });
    expect(tabTargetForPane(pane({ id: "terminal-legacy", type: "terminal" }))).toBeNull();
  });

  test("browser → il contextId; projectPath/taskId entrano SOLO dal contesto di chi chiama", () => {
    const id = createPaneId("browser", "ctx-42");
    expect(tabTargetForPane(pane({ id, type: "browser" }))).toEqual({ kind: "browser", key: "ctx-42" });
    expect(tabTargetForPane(pane({ id, type: "browser" }), { projectPath: "/work/x" }))
      .toEqual({ kind: "browser", key: "ctx-42", projectPath: "/work/x" });
    expect(tabTargetForPane(pane({ id, type: "browser" }), { taskId: "task-3" }))
      .toEqual({ kind: "browser", key: "ctx-42", taskId: "task-3" });
  });

  test("project → il path, decodificato dall'id", () => {
    expect(tabTargetForPane(pane({ id: createPaneId("project", "/Users/x/my.app"), type: "project" })))
      .toEqual({ kind: "project", key: "/Users/x/my.app" });
  });

  test("file/diff → si indirizza il CONTENUTO: l'id `file:<uuid>` è sorteggiato a ogni apertura", () => {
    const a = createPaneId("file");
    const b = createPaneId("file");
    expect(a).not.toBe(b); // ecco perché l'id non può essere la chiave
    expect(tabTargetForPane(pane({ id: a, type: "file", filePath: "/work/x/src/a.ts" }), { projectPath: "/work/x" }))
      .toEqual({ kind: "file", key: "/work/x/src/a.ts", projectPath: "/work/x" });
    // In vista diff il progetto ce l'ha il pane stesso (`diffProjectPath`).
    expect(tabTargetForPane(pane({ id: "diff:src/a.ts", type: "file", filePath: "/work/x/src/a.ts", diff: true, diffProjectPath: "/work/x" })))
      .toEqual({ kind: "diff", key: "/work/x/src/a.ts", projectPath: "/work/x" });
  });

  test("diff: il progetto è quello del DIFF, non quello della finestra che lo ospita", () => {
    // `open-file-diff` è un evento globale e non ha lo scoping di progetto che
    // `open-file` ha (shouldHandleOpenFile): un diff aperto dal Git del progetto
    // B compare ANCHE nella finestra di A, e lì il contesto del link dice `/A`.
    // Se vincesse il contesto, «Copia link» produrrebbe
    // `{key:'/B/src/x.ts', projectPath:'/A'}` — riaprendolo, `handleOpenDiff`
    // ricompone `/A//B/src/x.ts` e il pane nasce su un file inesistente.
    expect(
      tabTargetForPane(
        pane({ id: "diff:src/x.ts", type: "file", filePath: "/B/src/x.ts", diff: true, diffProjectPath: "/B" }),
        { projectPath: "/A" },
      ),
    ).toEqual({ kind: "diff", key: "/B/src/x.ts", projectPath: "/B" });
  });

  test("file senza progetto ospite → null: non sarebbe risolvibile", () => {
    expect(tabTargetForPane(pane({ id: createPaneId("file"), type: "file", filePath: "/work/x/src/a.ts" }))).toBeNull();
    expect(tabTargetForPane(pane({ id: createPaneId("file"), type: "file" }), { projectPath: "/work/x" })).toBeNull();
  });

  test("utility → il pannello, ma solo quelli indirizzabili", () => {
    for (const type of ["board", "dashboard", "cron"] as const) {
      expect(tabTargetForPane(pane({ id: utilityPanelId(type), type })))
        .toEqual({ kind: "panel", key: type });
    }
    // Un panel fuori da TAB_PANELS non è indirizzabile: un link che non apre
    // niente è peggio di nessun link.
    expect(tabTargetForPane(pane({ id: "__nonesiste__", type: "chat" }))).toBeNull();
  });

  test("i tipi con id casuale non sono indirizzabili — il null È il gate della voce di menu", () => {
    for (const type of ["kanban", "git", "files", "plan", "process-log"] as Pane["type"][]) {
      expect(tabTargetForPane(pane({ id: createPaneId(type), type }))).toBeNull();
    }
    expect(tabTargetForPane(pane({ id: createDraftPaneId(), type: "chat" }))).toBeNull();
  });
});

describe("getPaneConfig — safe lookup with chat fallback", () => {
  test("a reserved type with no PANE_CONFIG entry falls back to the chat config", () => {
    // 'context' is a reserved future PaneType with no PANE_CONFIG entry.
    expect(getPaneConfig("context")).toBe(getPaneConfig("chat"));
  });

  test("a configured type returns its own entry, not the fallback", () => {
    expect(getPaneConfig("terminal").label).toBe("Terminal");
  });
});
