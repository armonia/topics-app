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
import { adaptEnvelope } from "./adapt";
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

  it("a cut inside a code fence closes it: AGENTS.md after it is not read as code", () => {
    const dir = join(ROOT, "fence");
    mkdirSync(dir, { recursive: true });
    // A fence opens at 15k characters and closes at 30k: the 20k cut lands inside it.
    const readme = `${longText("# Fenced", 15_000)}\n\`\`\`bash\n${longText("echo sample", 15_000)}\n\`\`\`\n${longText("## After", 10_000)}`;
    writeFileSync(join(dir, "README.md"), readme);
    writeFileSync(join(dir, "AGENTS.md"), "# Agents\nAGENTS-RULE: never push to main.\n");

    const fences = (text: string) => text.split("\n").filter((l) => /^ {0,3}(`{3,}|~{3,})/.test(l)).length;
    expect(fences(block(dir, "template:README.md")!.content) % 2).toBe(0);
    const sent = adaptEnvelope(envelopeFor(dir)).userContent;
    const beforeRule = sent.slice(0, sent.indexOf("AGENTS-RULE"));
    expect(sent).toContain("AGENTS-RULE");
    expect(fences(beforeRule) % 2).toBe(0);
  });

  it("a cut with no line end in reach does not split a surrogate pair", () => {
    const dir = join(ROOT, "emoji");
    mkdirSync(dir, { recursive: true });
    // One line from char 4 on: the cut falls at exactly the cap, between the
    // two halves of the emoji that starts one character before it.
    const readme = `# E\n${"a".repeat(README_MAX_CHARS - 5)}\u{1F600}${"b".repeat(20_000)}`;
    expect(readme.charCodeAt(README_MAX_CHARS - 1)).toBe(0xd83d);
    writeFileSync(join(dir, "README.md"), readme);
    const content = block(dir, "template:README.md")!.content;
    expect(content).toContain("README.md cut here");
    // A lone surrogate does not survive a UTF-8 round trip.
    expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
  });

  it("CLAUDE.md is instructions: it arrives whole whatever its size", () => {
    const dir = join(ROOT, "rules");
    mkdirSync(dir, { recursive: true });
    const rules = `${longText("# Rules", 60_000)}\nLAST-RULE\n`;
    writeFileSync(join(dir, "CLAUDE.md"), rules);
    expect(block(dir, "template:CLAUDE.md")!.content).toBe(rules);
  });
});
