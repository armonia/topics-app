/**
 * A SKILL INVOCATION REACHES THE CLI BARE, WITH THE CONTEXT BESIDE IT: what a
 * (fake) CLI child actually receives on argv and stdin.
 *
 * The adapter decides (`payload.slashContext`), the provider writes. Here both
 * run for real against a child in the broker that logs its argv and every stdin
 * line verbatim (`tests/e2e/helpers/fake-claude-record-input.ts`):
 *  - a skill invocation with arguments on a first turn: ONE user message whose content is two text
 *    blocks, the `<context>` first and the command LAST, untouched. The CLI
 *    parses the last block as the input, so the skill expands with only the
 *    user's arguments (read in CLI 2.1.288, `precedingInputBlocks`);
 *  - an ordinary message: the old shape, one string with the context in front;
 *  - a pasted path `/tmp …`: the old shape too, since `tmp` is no skill;
 *  - argv: the context never travels there (`--append-system-prompt` is
 *    Topics' own fixed prompt, set at spawn).
 *
 * @covers SKILL-03
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { stopOwnAiBridges } from "../../scripts/stray-ai-bridges";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import type { StreamHandler } from "./types";
import type { ContextEnvelope, SystemBlock } from "../context/envelope";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SESSION = "topic:slash-context";
let tempDir = "";
let logPath = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }

beforeAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "slash-context-"));
  mkdirSync(join(tempDir, "data"), { recursive: true });
  setEnv("DATA_DIR", join(tempDir, "data"));
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("HOME", tempDir);
  setEnv("TOPICS_AI_BRIDGE_SOCKET", join(tempDir, "ai-bridge.sock"));
  // The user's skill, where the CLI (and `isKnownSlashCommand`) look for it.
  mkdirSync(join(tempDir, ".claude", "skills", "vai"), { recursive: true });
  writeFileSync(join(tempDir, ".claude", "skills", "vai", "SKILL.md"), "---\nname: vai\n---\n\nProcedi $ARGUMENTS.");
  logPath = join(tempDir, "fake-cli.jsonl");
  // A wrapper names the log and bun by absolute path: the CLI's environment is trimmed.
  const bun = execSync("command -v bun").toString().trim();
  const script = join(REPO_ROOT, "tests", "e2e", "helpers", "fake-claude-record-input.ts");
  const wrapper = join(tempDir, "fake-claude");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nexport FAKE_CLI_LOG="${logPath}"\nexec "${bun}" "${script}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  setEnv("TOPICS_CLAUDE_CLI_PATH", wrapper);
});

afterAll(async () => {
  await stopOwnAiBridges();
  try {
    const { closeDatabase } = await import("../db");
    closeDatabase();
  } catch { /* never opened */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

type LogLine = { event: "argv"; argv: string[] } | { event: "stdin"; line: string };
const readLog = (): LogLine[] => existsSync(logPath)
  ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogLine)
  : [];
/** The `message.content` of every user message the child read, in order. */
const userContents = (): unknown[] => readLog()
  .filter((l): l is { event: "stdin"; line: string } => l.event === "stdin")
  .map((l) => JSON.parse(l.line) as { type?: string; message?: { content?: unknown } })
  .filter((o) => o.type === "user")
  .map((o) => o.message?.content);

function recorder() {
  let resolveDone!: (r: string) => void;
  const done = new Promise<string>((r) => { resolveDone = r; });
  const handler: StreamHandler = {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: (m) => resolveDone(m?.result ?? ""),
    onError: (e: string) => resolveDone(`error:${e}`),
    onAborted: () => resolveDone("aborted"),
  } as StreamHandler;
  return { handler, done };
}

const PROMPT_BLOCK: SystemBlock = {
  id: "prompt:system", label: "prompt:system", category: "prompt",
  content: "TOPIC-PROMPT-MARK", tokens: 5, enabled: true, countInBudget: true,
  editable: false, injectedByTopicsApp: true,
};

function envelope(userContent: string): ContextEnvelope {
  return {
    topicId: "t-slc", sessionKey: SESSION, providerName: "claude-code", providerStrategy: "inline-system",
    systemBlocks: [PROMPT_BLOCK], history: [], userMessage: { content: userContent },
    diagnostics: {
      totalTokens: 0, budgetLimit: 200_000, budgetPercent: 0, droppedHistoryTurns: 0,
      historyEntries: [], warnings: [], assembledAt: 0,
    },
  };
}

describe("what the CLI child receives for a skill invocation (real child, broker)", () => {
  test("/vai goes bare as the last text block, the context in the block before it; other messages keep their shape", async () => {
    const { initDatabase, getDatabase } = await import("../db");
    initDatabase(REPO_ROOT);
    const now = new Date().toISOString();
    getDatabase().prepare(
      `INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("t-slc", "slc", "slc", SESSION, now, now);

    const { adaptEnvelope } = await import("../context/adapt");
    const { isKnownSlashCommand } = await import("../lib/slash-command-source");
    const isSlashCommand = (name: string) => isKnownSlashCommand(name, { home: tempDir, cwd: null });
    const { ClaudeCodeProvider } = await import("./claude-code");
    const provider = new ClaudeCodeProvider({ type: "claude-code", defaultWorkspace: tempDir });

    // Every turn is a "first turn" here (no dedup state): the preamble always has something to say.
    for (const text of ["/vai solo X", "vai avanti", "/tmp da controllare"]) {
      const payload = adaptEnvelope(envelope(text), { isSlashCommand });
      const r = recorder();
      void provider.sendChat(SESSION, payload.userContent, r.handler, { slashContext: payload.slashContext });
      expect(await r.done).toBe("got");
    }

    const [skill, ordinary, path] = userContents();
    expect(skill).toEqual([
      { type: "text", text: "<context>\nTOPIC-PROMPT-MARK\n</context>" },
      { type: "text", text: "/vai solo X" },
    ]);
    expect(ordinary).toBe("<context>\nTOPIC-PROMPT-MARK\n</context>\n\nvai avanti");
    expect(path).toBe("<context>\nTOPIC-PROMPT-MARK\n</context>\n\n/tmp da controllare");

    const argvLines = readLog().filter((l): l is { event: "argv"; argv: string[] } => l.event === "argv");
    expect(argvLines).toHaveLength(1);
    expect(argvLines[0]!.argv.join(" ")).not.toContain("TOPIC-PROMPT-MARK");
    expect(argvLines[0]!.argv).toContain("--input-format");

    await provider.stop();
  }, 45_000);
});
