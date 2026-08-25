/**
 * Unit coverage for the SDK-passthrough control tools (server/control-tools.ts)
 * and the shared switch/create-topic cores (server/lib/session-control-core.ts).
 *
 * These are the claude/openai passthrough successors to the {{PROJECT_*}} /
 * {{TOPIC_*}} markers. The dispatcher runs in-process (no HTTP), driving the
 * same side-effect helpers the Layer-1 endpoints use, so we assert: the correct
 * broadcasts, the AC-01 error semantics (409-equivalent collision, archived,
 * unknown ref, trustRawPaths:false), and the tool-list projection shape.
  * @covers CTRLTOOL-01
 */
import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  controlTools,
  isControlTool,
  dispatchControlToolCall,
  ControlToolError,
  type ControlDispatchDeps,
} from "./control-tools";
import type { Topic } from "./types";

function makeTopic(overrides: Partial<Topic> & { id: string }): Topic {
  return {
    name: overrides.id,
    slug: overrides.id,
    parentId: null,
    links: [],
    sessionKey: `topic:${overrides.id}`,
    color: "#5865f2",
    icon: "MessageSquare",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    ...overrides,
  } as Topic;
}

/**
 * In-memory deps: a topics Map + broadcast capture + a temp workspace. The
 * project resolver/binder mimic the real closure helpers just enough for the
 * dispatcher: resolveProjectRef(trustRawPaths:false) resolves a bare name to a
 * workspace dir that has a CLAUDE.md, refusing unknown names AND absolute paths;
 * bindTopicToProject stamps projectPath + broadcasts, like the real one.
 */
function makeDeps() {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ctrl-tools-"));
  const topics = new Map<string, Topic>();
  const broadcasts: Array<{ type: string } & Record<string, unknown>> = [];

  const deps: ControlDispatchDeps = {
    getTopicById: (id) => topics.get(id) ?? null,
    loadTopics: () => ({ topics: Object.fromEntries(topics) }),
    saveSingleTopic: (t) => { topics.set(t.id, t); },
    slugify: (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    broadcastToAll: (msg) => { broadcasts.push(msg as { type: string } & Record<string, unknown>); },
    resolveProjectRef: (ref) => {
      // trustRawPaths:false — only resolve a bare NAME that maps to a known
      // workspace project (has CLAUDE.md). Absolute paths / unknown names → null.
      if (ref.startsWith("/")) return null;
      const dir = join(workspaceDir, ref);
      return existsSync(join(dir, "CLAUDE.md")) ? dir : null;
    },
    bindTopicToProject: (topicId, targetDir) => {
      const t = topics.get(topicId);
      if (!t) return false;
      t.projectPath = targetDir;
      broadcasts.push({ type: "topic:updated", topic: t });
      broadcasts.push({ type: "pane:focus-suggest", topicId, projectPath: targetDir });
      return true;
    },
    workspaceDir,
  };
  return { deps, topics, broadcasts, workspaceDir, cleanup: () => rmSync(workspaceDir, { recursive: true, force: true }) };
}

describe("controlTools projection", () => {
  test("exposes exactly the four control tools with required args", () => {
    expect(controlTools.map((t) => t.name)).toEqual([
      "switch_topic", "new_topic", "create_project", "open_project", "resolve_tab",
    ]);
    expect(controlTools.find((t) => t.name === "switch_topic")!.input_schema.required).toEqual(["topic_id"]);
    expect(controlTools.find((t) => t.name === "new_topic")!.input_schema.required).toEqual(["title"]);
    expect(controlTools.find((t) => t.name === "create_project")!.input_schema.required).toEqual(["name"]);
    expect(controlTools.find((t) => t.name === "open_project")!.input_schema.required).toEqual(["ref"]);
    expect(controlTools.find((t) => t.name === "resolve_tab")!.input_schema.required).toEqual(["ref"]);
  });

  test("resolve_tab is advertised to the SDK passthrough — that's where links get pasted", () => {
    // Il gemello del tool MCP. I provider claude/openai non vedono l'MCP: senza
    // questa voce in `controlTools` (= `sendOptions.tools`) il tool esisterebbe
    // per gli agenti dispatchati e NON per la chat, cioè al contrario del caso d'uso.
    const spec = controlTools.find((t) => t.name === "resolve_tab")!;
    expect(spec).toBeDefined();
    expect((spec.input_schema.properties as any).ref.type).toBe("string");
    // Il passthrough è a turno singolo: il modello non riceve il risultato. La
    // descrizione glielo deve dire, o riassume a memoria un output mai visto.
    expect(spec.description).toMatch(/do NOT receive it back in this turn/);
  });

  test("isControlTool recognizes the five names and rejects others", () => {
    for (const n of ["switch_topic", "new_topic", "create_project", "open_project", "resolve_tab"]) {
      expect(isControlTool(n)).toBe(true);
    }
    expect(isControlTool("browser_open")).toBe(false);
    expect(isControlTool("move_session_to_project")).toBe(false);
  });
});

describe("dispatchControlToolCall — switch_topic", () => {
  test("broadcasts topic:switch for an existing non-archived target", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      h.topics.set("tgt", makeTopic({ id: "tgt" }));
      const text = await dispatchControlToolCall("switch_topic", { topic_id: "tgt" }, cur, h.deps);
      expect(text).toContain("tgt");
      expect(h.broadcasts.find((b) => b.type === "topic:switch")).toMatchObject({
        fromTopicId: "cur", toTopicId: "tgt", toSessionKey: "topic:tgt",
      });
    } finally { h.cleanup(); }
  });

  test("throws archived (not not_found) for an archived target — no broadcast", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      h.topics.set("dead", makeTopic({ id: "dead", archived: true }));
      await expect(dispatchControlToolCall("switch_topic", { topic_id: "dead" }, cur, h.deps))
        .rejects.toThrow(/archived/i);
      expect(h.broadcasts.filter((b) => b.type === "topic:switch")).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("throws not_found for a missing target and bad_args for a missing id", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      await expect(dispatchControlToolCall("switch_topic", { topic_id: "ghost" }, cur, h.deps))
        .rejects.toThrow(/not found/i);
      await expect(dispatchControlToolCall("switch_topic", {}, cur, h.deps))
        .rejects.toThrow(/topic_id.*required/i);
    } finally { h.cleanup(); }
  });
});

describe("dispatchControlToolCall — new_topic", () => {
  test("creates a topic inheriting projectPath and broadcasts created then switch", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur", projectPath: "/tmp/proj" });
      h.topics.set("cur", cur);
      const text = await dispatchControlToolCall("new_topic", { title: "My Findings" }, cur, h.deps);
      expect(text).toContain("My Findings");
      const created = [...h.topics.values()].find((t) => t.name === "My Findings")!;
      expect(created.projectPath).toBe("/tmp/proj");
      const types = h.broadcasts.map((b) => b.type);
      expect(types.indexOf("topic:created")).toBeGreaterThanOrEqual(0);
      expect(types.indexOf("topic:created")).toBeLessThan(types.indexOf("topic:switch"));
    } finally { h.cleanup(); }
  });

  test("throws bad_args when title missing", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      await expect(dispatchControlToolCall("new_topic", {}, cur, h.deps)).rejects.toThrow(/title.*required/i);
    } finally { h.cleanup(); }
  });
});

describe("dispatchControlToolCall — create_project", () => {
  test("scaffolds dir + CLAUDE.md, binds, broadcasts", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      const text = await dispatchControlToolCall("create_project", { name: "FreshProj" }, cur, h.deps);
      const dir = join(h.workspaceDir, "FreshProj");
      expect(text).toContain(dir);
      expect(existsSync(dir)).toBe(true);
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toContain("FreshProj");
      expect(h.topics.get("cur")!.projectPath).toBe(dir);
      expect(h.broadcasts.some((b) => b.type === "pane:focus-suggest")).toBe(true);
    } finally { h.cleanup(); }
  });

  test("throws project_exists on collision — no overwrite, no bind, no broadcast", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      const dir = join(h.workspaceDir, "Taken");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "CLAUDE.md"), "# original\n");
      await expect(dispatchControlToolCall("create_project", { name: "Taken" }, cur, h.deps))
        .rejects.toThrow(/already exists/i);
      expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("# original\n");
      expect(h.topics.get("cur")!.projectPath).toBeUndefined();
      expect(h.broadcasts).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("throws bad_args when name empty after sanitization", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      await expect(dispatchControlToolCall("create_project", { name: "***" }, cur, h.deps))
        .rejects.toThrow(/alphanumeric.*required|name.*required/i);
    } finally { h.cleanup(); }
  });
});

describe("dispatchControlToolCall — open_project", () => {
  test("resolves a known workspace project by name, binds + broadcasts", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      const dir = join(h.workspaceDir, "knownproj");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "CLAUDE.md"), "# knownproj\n");
      const text = await dispatchControlToolCall("open_project", { ref: "knownproj" }, cur, h.deps);
      expect(text).toContain(dir);
      expect(h.topics.get("cur")!.projectPath).toBe(dir);
      expect(h.broadcasts.some((b) => b.type === "topic:updated")).toBe(true);
    } finally { h.cleanup(); }
  });

  test("throws not_found for unknown ref AND for an absolute path (trustRawPaths:false)", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      await expect(dispatchControlToolCall("open_project", { ref: "no-such" }, cur, h.deps))
        .rejects.toThrow(/not found/i);
      await expect(dispatchControlToolCall("open_project", { ref: "/etc" }, cur, h.deps))
        .rejects.toThrow(/not found/i);
      expect(h.broadcasts).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("throws bad_args when ref missing", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      await expect(dispatchControlToolCall("open_project", {}, cur, h.deps)).rejects.toThrow(/ref.*required/i);
    } finally { h.cleanup(); }
  });
});

describe("dispatchControlToolCall — resolve_tab", () => {
  const RESOLVED = {
    kind: "chat" as const,
    key: "topic-1",
    title: "Rifattorizzare il resolver",
    state: "open" as const,
    surface: "app" as const,
    pointers: { topicId: "topic-1", sessionKey: "topic:topic-1" },
    next: { tool: "read_chat_messages", args: { topic_id: "topic-1" } },
  };

  test("returns the resolved tab verbatim as JSON — nessun effetto collaterale", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      let seenRef = "";
      h.deps.resolveTab = (ref) => { seenRef = ref; return RESOLVED; };
      const text = await dispatchControlToolCall(
        "resolve_tab", { ref: "  https://127.0.0.1:3333/tab/chat/topic-1  " }, cur, h.deps,
      );
      expect(seenRef).toBe("https://127.0.0.1:3333/tab/chat/topic-1"); // trimmato
      expect(JSON.parse(text)).toEqual(RESOLVED);
      // Sola lettura: il resolver non deve muovere nulla (né topic, né broadcast).
      expect(h.broadcasts).toHaveLength(0);
      expect(h.topics.get("cur")!.projectPath).toBeUndefined();
    } finally { h.cleanup(); }
  });

  test("un ref che non è un permalink è 'not a tab permalink', NON 'non esiste'", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      h.deps.resolveTab = () => null;
      const err = await dispatchControlToolCall("resolve_tab", { ref: "https://example.com/x" }, cur, h.deps)
        .then(() => null, (e: unknown) => e as ControlToolError);
      expect(err).toBeInstanceOf(ControlToolError);
      expect(err!.code).toBe("not_a_tab_link");
      expect(err!.message).toMatch(/not a tab permalink/i);
      // La distinzione conta: un «not found» farebbe concludere al modello che la
      // tab è stata cancellata, che è un'altra cosa.
      expect(err!.message).not.toMatch(/not found/i);
    } finally { h.cleanup(); }
  });

  test("throws bad_args on a missing / blank ref, senza chiamare il resolver", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      let called = false;
      h.deps.resolveTab = () => { called = true; return RESOLVED; };
      await expect(dispatchControlToolCall("resolve_tab", {}, cur, h.deps)).rejects.toThrow(/ref.*required/i);
      await expect(dispatchControlToolCall("resolve_tab", { ref: "   " }, cur, h.deps)).rejects.toThrow(/ref.*required/i);
      expect(called).toBe(false);
    } finally { h.cleanup(); }
  });

  test("senza il resolver iniettato dice 'not wired' invece di inventare una risposta", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      expect(h.deps.resolveTab).toBeUndefined();
      const err = await dispatchControlToolCall("resolve_tab", { ref: "/task/t-1" }, cur, h.deps)
        .then(() => null, (e: unknown) => e as ControlToolError);
      expect(err).toBeInstanceOf(ControlToolError);
      expect(err!.code).toBe("unavailable");
    } finally { h.cleanup(); }
  });
});

describe("dispatchControlToolCall — unknown tool", () => {
  test("throws ControlToolError with unknown_tool code", async () => {
    const h = makeDeps();
    try {
      const cur = makeTopic({ id: "cur" });
      h.topics.set("cur", cur);
      await expect(dispatchControlToolCall("nope", {}, cur, h.deps)).rejects.toBeInstanceOf(ControlToolError);
    } finally { h.cleanup(); }
  });
});
