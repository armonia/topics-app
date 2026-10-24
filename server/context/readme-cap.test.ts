/**
 * The project README reaches the model capped, with a pointer to the rest.
 * @covers CTX-README-01
 *
 * On 24/10 the finance project's README.md was 136k characters, about 55-60k
 * tokens, sent whole in the context block of every chat on that project. The
 * README is an overview, not instructions: its head is what orients the
 * agent, and the file stays one Read away. CLAUDE.md and AGENTS.md are the
 * project's instructions and arrive whole, as Claude Code loads them.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext, Topic } from "../types";
import { README_MAX_CHARS, assembleTopicContext } from "./assemble";

const ROOT = join(process.env.TMPDIR ?? "/tmp", `readme-cap-${process.pid}`);

function envelopeFor(projectDir: string) {
  const topic = { id: "t1", name: "Chat", sessionKey: "topic:t1", projectPath: projectDir } as unknown as Topic;
  const ctx = {
    BASE_DIR: ROOT,
    STATE_DIR: ROOT,
    OPENCLAW_DIR: join(ROOT, "openclaw"),
    getTopicBySessionKey: (sk: string) => (sk === topic.sessionKey ? topic : null),
    loadLocalMessages: () => [],
    loadTopics: () => ({ topics: { [topic.id]: topic } }),
    resolveTopicCwd: () => projectDir,
    db: new Database(":memory:"),
  } as unknown as AppContext;
  return assembleTopicContext(ctx, { sessionKey: "topic:t1", providerName: "topics", providerStrategy: "inline-system" });
}

const block = (projectDir: string, id: string) => envelopeFor(projectDir).systemBlocks.find((b) => b.id === id);

/** `n` characters of markdown, in lines, starting with `head`. */
function longText(head: string, n: number): string {
  let s = `${head}\n`;
  for (let i = 0; s.length < n; i++) s += `- line ${i} of a long project overview\n`;
  return s.slice(0, n);
}

beforeAll(() => mkdirSync(ROOT, { recursive: true }));
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* scratch */ } });

describe("the README in the context block", () => {
  it("over the cap: the head arrives, the tail does not, and the note names the file", () => {
    const dir = join(ROOT, "big");
    mkdirSync(dir, { recursive: true });
    const readme = `${longText("# Finance HEAD-OF-README", 136_000)}\nTAIL-OF-README\n`;
    writeFileSync(join(dir, "README.md"), readme);

    const b = block(dir, "template:README.md")!;
    expect(b.content).toContain("HEAD-OF-README");
    expect(b.content).not.toContain("TAIL-OF-README");
    expect(b.content.length).toBeLessThan(README_MAX_CHARS + 400);
    expect(b.content).toContain(join(dir, "README.md"));
    expect(b.content).toContain(String(readme.length));
    // The budget the inspector shows is what is sent, not the file on disk.
    expect(b.tokens).toBeLessThan(Math.round(readme.length / 4) / 2);
  });

  it("under the cap: the README arrives whole, with no note", () => {
    const dir = join(ROOT, "small");
    mkdirSync(dir, { recursive: true });
    const readme = longText("# Small", 8_000);
    writeFileSync(join(dir, "README.md"), readme);
    expect(block(dir, "template:README.md")!.content).toBe(readme);
  });

  it("CLAUDE.md is instructions: it arrives whole whatever its size", () => {
    const dir = join(ROOT, "rules");
    mkdirSync(dir, { recursive: true });
    const rules = `${longText("# Rules", 60_000)}\nLAST-RULE\n`;
    writeFileSync(join(dir, "CLAUDE.md"), rules);
    expect(block(dir, "template:CLAUDE.md")!.content).toBe(rules);
  });
});
