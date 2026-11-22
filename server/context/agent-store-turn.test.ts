/**
 * The turn of an agent receives its own memory index, never another agent's.
 * @covers SYSTEM-PAGE-01
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext, Topic } from "../types";
import { assembleTopicContext } from "./assemble";

const ROOT = join(tmpdir(), `agent-store-turn-${process.pid}`);
const saved = { home: process.env.TOPICS_HOME, engine: process.env.JARVIS_CHANNELS_HOME };

function envelopeFor(cwd: string) {
  const topic = { id: "t1", name: "Chat", sessionKey: "topic:t1", projectPath: cwd } as unknown as Topic;
  const ctx = {
    BASE_DIR: ROOT,
    STATE_DIR: ROOT,
    APP_DATA_DIR: join(ROOT, "app-data"),
    getTopicBySessionKey: () => topic,
    loadLocalMessages: () => [],
    loadTopics: () => ({ topics: { [topic.id]: topic } }),
    resolveTopicCwd: () => cwd,
    db: new Database(":memory:"),
  } as unknown as AppContext;
  return assembleTopicContext(ctx, { sessionKey: "topic:t1", providerName: "topics", providerStrategy: "inline-system" });
}

beforeAll(() => {
  const engine = join(ROOT, "engine");
  mkdirSync(engine, { recursive: true });
  writeFileSync(
    join(engine, "engine.json"),
    JSON.stringify({ agents: { alpha: { workspace: join(ROOT, "ws-alpha") }, beta: { workspace: join(ROOT, "ws-beta") } } }),
  );
  for (const id of ["alpha", "beta"]) {
    mkdirSync(join(ROOT, `ws-${id}`), { recursive: true });
    const mem = join(ROOT, "topics", "agents", id, "memory");
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, "MEMORY.md"), `- [${id.toUpperCase()}-SECRET](card.md)\n`);
    writeFileSync(join(mem, "card.md"), "---\nname: card\n---\nbody\n");
  }
  process.env.TOPICS_HOME = join(ROOT, "topics");
  process.env.JARVIS_CHANNELS_HOME = engine;
});

afterAll(() => {
  for (const [key, value] of [["TOPICS_HOME", saved.home], ["JARVIS_CHANNELS_HOME", saved.engine]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* scratch */ }
});

describe("memory stores in the turn context", () => {
  it("an agent's turn gets its own index and not another agent's", () => {
    const text = envelopeFor(join(ROOT, "ws-alpha")).systemBlocks.map((b) => b.content).join("\n");
    expect(text).toContain("ALPHA-SECRET");
    expect(text).not.toContain("BETA-SECRET");
  });

  it("an ordinary topic gets no agent store", () => {
    const blocks = envelopeFor(join(ROOT, "elsewhere")).systemBlocks;
    expect(blocks.some((b) => b.id.startsWith("memory:store:"))).toBe(false);
  });
});
