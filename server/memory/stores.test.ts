// @covers SYSTEM-PAGE-01
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  archiveCard,
  discoverStores,
  readCard,
  readMemoryStoresConfig,
  searchStores,
  storeProblems,
  storesForTurn,
  writeCard,
  type MemoryStoresConfig,
} from "./stores";
import type { AgentRecord } from "../agents/registry";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function card(dir: string, file: string, opts: { name: string; description?: string; type?: string; body?: string }): void {
  mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `name: ${opts.name}`,
    `description: ${opts.description ?? ""}`,
    "metadata:",
    `  type: ${opts.type ?? "project"}`,
    "---",
    "",
    opts.body ?? "",
  ].join("\n");
  writeFileSync(join(dir, file), fm);
}

function agent(id: string, workspace = ""): AgentRecord {
  return { id, name: id, job: "", workspace };
}

describe("discoverStores", () => {
  test("an agent's own folder is always a store, always received by it, no configuration needed", () => {
    const agentsHome = tmp("memory-agents-");
    const storeDir = join(agentsHome, "folder-not-the-id", "memory");
    card(storeDir, "lesson.md", { name: "Lesson" });
    writeFileSync(join(storeDir, "MEMORY.md"), "- [Lesson](lesson.md)\n");

    const stores = discoverStores([agent("jarvis", join(agentsHome, "folder-not-the-id"))], {
      claudeProjectsHome: tmp("memory-projects-empty-"),
      config: {},
    });

    expect(stores).toHaveLength(1);
    expect(stores[0]!.id).toBe("agent:jarvis");
    expect(stores[0]!.cards).toHaveLength(1);
    expect(stores[0]!.path).toBe(storeDir);
    expect(stores[0]!.receivedBy).toEqual(["jarvis"]);
    expect(storeProblems(stores[0]!)).toEqual([]);
  });

  test("a project store nobody is granted is read, but nobody receives it (SYSTEM-03)", () => {
    const projectsHome = tmp("memory-projects-");
    const projectDir = join(projectsHome, "-home-topics-repo", "memory");
    for (let i = 0; i < 3; i++) card(projectDir, `card-${i}.md`, { name: `Card ${i}` });
    // no MEMORY.md written: the second part of SYSTEM-03, an index that is not just unreceived but missing

    const stores = discoverStores([], {
      claudeProjectsHome: projectsHome,
      config: {},
    });

    expect(stores).toHaveLength(1);
    const store = stores[0]!;
    expect(store.cards).toHaveLength(3);
    expect(store.index).toBeNull();
    expect(store.receivedBy).toEqual([]);

    const problems = storeProblems(store);
    expect(problems.map((p) => p.kind).sort()).toEqual(["index-missing", "unreceived"]);
    expect(problems.find((p) => p.kind === "unreceived")!.text).toContain("topics-repo");
  });

  test("an index past Claude Code's own limit is flagged", () => {
    const agentsHome = tmp("memory-agents-overlimit-");
    const storeDir = join(agentsHome, "visione", "memory");
    card(storeDir, "lesson.md", { name: "Lesson" });
    writeFileSync(join(storeDir, "MEMORY.md"), "x".repeat(30_000));

    const stores = discoverStores([agent("visione", join(agentsHome, "visione"))], {
      claudeProjectsHome: tmp("memory-projects-empty-2-"),
      config: {},
    });

    expect(stores[0]!.index?.overLimit).toBe(true);
    expect(storeProblems(stores[0]!).some((p) => p.kind === "index-over-limit")).toBe(true);
  });

  test("a 'shared' grant adds a receiver without taking away the owner's; a 'readonly' grant never auto-receives (ambito applicato al turno)", () => {
    const agentsHome = tmp("memory-agents-scope-");
    const ownerDir = join(agentsHome, "jarvis", "memory");
    card(ownerDir, "lesson.md", { name: "Lesson" });
    writeFileSync(join(ownerDir, "MEMORY.md"), "- [Lesson](lesson.md)\n");

    const config: MemoryStoresConfig = {
      agents: {
        visione: [{ storeId: "agent:jarvis", scope: "shared" }],
        guest: [{ storeId: "agent:jarvis", scope: "readonly" }],
      },
    };
    const stores = discoverStores([agent("jarvis", join(agentsHome, "jarvis")), agent("visione", join(agentsHome, "visione")), agent("guest", join(agentsHome, "guest"))], {
      claudeProjectsHome: tmp("memory-projects-empty-3-"),
      config,
    });
    const store = stores.find((s) => s.id === "agent:jarvis")!;
    expect(store.receivedBy.sort()).toEqual(["jarvis", "visione"]);
    expect(store.readableBy).toEqual(["guest"]);

    // The scope applied to the turn: jarvis and visione get it handed to them, guest does not.
    expect(storesForTurn("jarvis", stores).map((s) => s.id)).toEqual(["agent:jarvis"]);
    expect(storesForTurn("visione", stores).map((s) => s.id).sort()).toEqual(["agent:jarvis", "agent:visione"]);
    expect(storesForTurn("guest", stores).map((s) => s.id)).toEqual(["agent:guest"]);
  });
});

describe("readMemoryStoresConfig", () => {
  test("engine.json's agents.<id>.memory becomes grants; missing file is no grants, never an error", () => {
    const home = tmp("memory-engine-");
    expect(readMemoryStoresConfig(home)).toEqual({});

    writeFileSync(
      join(home, "engine.json"),
      JSON.stringify({ agents: { visione: { memory: [{ storeId: "agent:jarvis", scope: "shared" }] }, jarvis: {} } }),
    );
    expect(readMemoryStoresConfig(home)).toEqual({ agents: { visione: [{ storeId: "agent:jarvis", scope: "shared" }] } });
  });
});

describe("searchStores (SYSTEM-05)", () => {
  test("the same word in two stores' cards comes back as two results, each with its own store", () => {
    const agentsHome = tmp("memory-agents-search-");
    const jarvisDir = join(agentsHome, "jarvis", "memory");
    const outreachDir = join(agentsHome, "outreach", "memory");
    card(jarvisDir, "lesson.md", { name: "Lesson", body: "the gateway restarts on its own" });
    card(outreachDir, "lesson.md", { name: "Lesson", body: "the outreach gateway needs a token" });

    const stores = discoverStores([agent("jarvis", join(agentsHome, "jarvis")), agent("outreach", join(agentsHome, "outreach"))], {
      claudeProjectsHome: tmp("memory-projects-empty-4-"),
      config: {},
    });

    const results = searchStores(stores, "gateway");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.storeId).sort()).toEqual(["agent:jarvis", "agent:outreach"]);
    for (const r of results) expect(r.snippet.toLowerCase()).toContain("gateway");
  });

  test("an empty query matches nothing", () => {
    expect(searchStores([], "   ")).toEqual([]);
  });
});

describe("readCard / writeCard / archiveCard", () => {
  test("write backs up the previous content before overwriting", () => {
    const storeDir = tmp("memory-write-");
    card(storeDir, "lesson.md", { name: "Lesson", body: "v1" });

    const { backup } = writeCard(storeDir, "lesson.md", "v2 content");
    expect(readCard(storeDir, "lesson.md")).toBe("v2 content");
    expect(backup).toBeTruthy();
    expect(readFileSync(backup!, "utf8")).toContain("v1");
  });

  test("archive moves the card's content into ARCHIVE.md and removes the card, backed up", () => {
    const storeDir = tmp("memory-archive-");
    card(storeDir, "old.md", { name: "Old", body: "an old lesson" });

    const { archivePath, backup } = archiveCard(storeDir, "old.md");
    expect(existsSync(join(storeDir, "old.md"))).toBe(false);
    expect(readFileSync(archivePath, "utf8")).toContain("an old lesson");
    expect(backup).toBeTruthy();
  });

  test("a path outside the store is refused, never written", () => {
    const storeDir = tmp("memory-escape-");
    expect(() => writeCard(storeDir, "../escape.md", "x")).toThrow();
  });
});
