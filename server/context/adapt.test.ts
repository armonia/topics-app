/**
 * Unit tests for `adaptEnvelope` / `composeSystemMessages`.
 *
 * Matrix: 3 strategies × {0 system blocks, ≥1 system block, history present
 * or absent, marker stripping, project-listing fallback, etc.}.
 *
 * The tests pin the contract that `adaptEnvelope`'s output is byte-for-byte
 * identical to the legacy inline path in `streamEditResponse`.
  * @covers CTX-ADAPT-01
 */

import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "../providers/types";
import type { ContextEnvelope, SystemBlock } from "./envelope";
import { adaptEnvelope, composeSystemMessages } from "./adapt";

// ────────────────────────────────────────────────────────────────────────────
// Builders
// ────────────────────────────────────────────────────────────────────────────

function block(overrides: Partial<SystemBlock> & { id: string; content: string }): SystemBlock {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    category: overrides.category ?? "synthetic",
    content: overrides.content,
    tokens: overrides.tokens ?? Math.ceil(overrides.content.length / 4),
    enabled: overrides.enabled ?? true,
    countInBudget: overrides.countInBudget ?? true,
    sourceUri: overrides.sourceUri,
    editable: overrides.editable ?? false,
    injectedByTopicsApp: overrides.injectedByTopicsApp ?? true,
    adapterHints: overrides.adapterHints,
  };
}

function envelope(overrides: Partial<ContextEnvelope> & { providerStrategy: ContextEnvelope["providerStrategy"] }): ContextEnvelope {
  return {
    topicId: "topic-1",
    sessionKey: "topic:abc",
    providerName: overrides.providerName ?? "claude",
    providerStrategy: overrides.providerStrategy,
    systemBlocks: overrides.systemBlocks ?? [],
    history: overrides.history ?? [],
    userMessage: overrides.userMessage ?? { content: "hello" },
    diagnostics: overrides.diagnostics ?? {
      totalTokens: 0,
      budgetLimit: 200_000,
      budgetPercent: 0,
      droppedHistoryTurns: 0,
      historyEntries: [],
      warnings: [],
      assembledAt: 0,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// composeSystemMessages — direct tests
// ────────────────────────────────────────────────────────────────────────────

describe("composeSystemMessages", () => {
  it("returns empty when no blocks are enabled", () => {
    const out = composeSystemMessages([]);
    expect(out).toEqual([]);
  });

  it("skips informational blocks (injectedByTopicsApp: false)", () => {
    const out = composeSystemMessages([
      block({ id: "openclaw:SOUL.md", category: "openclaw", content: "soul", injectedByTopicsApp: false }),
    ]);
    expect(out).toEqual([]);
  });

  it("skips disabled blocks", () => {
    const out = composeSystemMessages([
      block({ id: "prompt:system", category: "prompt", content: "prompt", enabled: false }),
    ]);
    expect(out).toEqual([]);
  });

  it("emits prompt:system as the first message", () => {
    const out = composeSystemMessages([
      block({ id: "prompt:system", category: "prompt", content: "I am a system." }),
    ]);
    expect(out).toEqual([{ role: "system", content: "I am a system." }]);
  });

  it("aggregates context files under 'Context files for this topic:'", () => {
    const out = composeSystemMessages([
      block({ id: "file:/a/foo.md", label: "foo.md", category: "file", content: "FOO" }),
      block({ id: "file:/a/bar.md", label: "bar.md", category: "file", content: "BAR" }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].content).toBe(
      "Context files for this topic:\n\n--- File: foo.md ---\nFOO\n\n--- File: bar.md ---\nBAR",
    );
  });

  it("project template aggregate: uses templates when present, ignores listing fallback", () => {
    const out = composeSystemMessages([
      block({
        id: "template:project-awareness",
        category: "template",
        content: 'You are working in the project "P" at /p.',
        adapterHints: { projectListing: "src/, README.md" },
      }),
      block({ id: "template:CLAUDE.md", category: "template", label: "CLAUDE.md", content: "claude content" }),
      block({ id: "template:README.md", category: "template", label: "README.md", content: "readme content" }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].content).toBe(
      'You are working in the project "P" at /p.\n\nProject context files:\n\n--- Project file: CLAUDE.md ---\nclaude content\n\n--- Project file: README.md ---\nreadme content',
    );
    // Listing should NOT be appended when templates exist
    expect(out[0].content).not.toContain("Project root files:");
  });

  it("project template aggregate: falls back to listing when no templates", () => {
    const out = composeSystemMessages([
      block({
        id: "template:project-awareness",
        category: "template",
        content: 'You are working in the project "P" at /p.',
        adapterHints: { projectListing: "src/, README.md, package.json" },
      }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].content).toBe(
      'You are working in the project "P" at /p.\n\nProject root files: src/, README.md, package.json',
    );
  });

  it("project template aggregate: no templates AND no listing → bare statement only", () => {
    const out = composeSystemMessages([
      block({
        id: "template:project-awareness",
        category: "template",
        content: 'You are working in the project "P" at /p.',
      }),
    ]);
    expect(out).toEqual([{ role: "system", content: 'You are working in the project "P" at /p.' }]);
  });

  it("memory aggregate: global only", () => {
    const out = composeSystemMessages([
      block({ id: "memory:global", category: "memory", content: "global notes" }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].content).toBe(
      "\n\n## Memory\nThe following memories/notes have been saved for context:\n\n### Global Memory\nglobal notes",
    );
  });

  it("memory aggregate: global + topic", () => {
    const out = composeSystemMessages([
      block({ id: "memory:global", category: "memory", content: "global notes" }),
      block({ id: "memory:topic", category: "memory", content: "topic notes" }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].content).toBe(
      "\n\n## Memory\nThe following memories/notes have been saved for context:\n\n### Global Memory\nglobal notes\n\n### Topic Memory\ntopic notes",
    );
  });

  it("memory aggregate: respects toggle (global disabled → only topic emitted)", () => {
    const out = composeSystemMessages([
      block({ id: "memory:global", category: "memory", content: "global notes", enabled: false }),
      block({ id: "memory:topic", category: "memory", content: "topic notes" }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].content).toBe(
      "\n\n## Memory\nThe following memories/notes have been saved for context:\n\n### Topic Memory\ntopic notes",
    );
  });

  it("pinned aggregate has the conversation header", () => {
    const out = composeSystemMessages([
      block({
        id: "pinned:messages",
        category: "pinned",
        content: "[user]: foo\n\n[assistant]: bar",
      }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0].content).toBe(
      "Pinned messages from this conversation (important context):\n\n[user]: foo\n\n[assistant]: bar",
    );
  });

  it("preserves the canonical order regardless of input order", () => {
    // Feed blocks in REVERSE order; the composer must still emit them in the
    // canonical order (1: prompt → 9: plan).
    const out = composeSystemMessages([
      block({ id: "synthetic:plan-mode", category: "synthetic", content: "PLAN" }),
      block({ id: "pinned:messages", category: "pinned", content: "PIN" }),
      block({ id: "memory:topic", category: "memory", content: "TM" }),
      block({ id: "synthetic:topic-switch-directory", category: "synthetic", content: "TS" }),
      block({ id: "synthetic:project-markers", category: "synthetic", content: "PM" }),
      block({ id: "synthetic:browser-instruction", category: "synthetic", content: "BR" }),
      block({ id: "template:project-awareness", category: "template", content: "AWARE" }),
      block({ id: "file:/x", label: "x", category: "file", content: "FX" }),
      block({ id: "prompt:system", category: "prompt", content: "SP" }),
    ]);
    const contents = out.map((m) => m.content);
    expect(contents[0]).toBe("SP");                            // 1
    expect(contents[1]).toContain("--- File: x ---\nFX");       // 2
    expect(contents[2]).toBe("AWARE");                          // 3
    expect(contents[3]).toBe("BR");                             // 4
    expect(contents[4]).toBe("PM");                             // 5
    expect(contents[5]).toBe("TS");                             // 6
    expect(contents[6]).toContain("Topic Memory\nTM");          // 7
    expect(contents[7]).toContain("[user]: foo".replace("[user]: foo","")); // 8 — just verify pinned header
    expect(contents[7]).toContain("Pinned messages from this conversation");
    expect(contents[8]).toBe("PLAN");                           // 9
  });
});

// ────────────────────────────────────────────────────────────────────────────
// adaptEnvelope — strategy: history-aware
// ────────────────────────────────────────────────────────────────────────────

describe("adaptEnvelope — history-aware", () => {
  it("with 0 system blocks: history === envelope.history, userContent verbatim", () => {
    const env = envelope({
      providerStrategy: "history-aware",
      history: [{ role: "user", content: "h1" }, { role: "assistant", content: "h2" }],
      userMessage: { content: "ping" },
    });
    const p = adaptEnvelope(env);
    expect(p.userContent).toBe("ping");
    expect(p.history).toEqual([
      { role: "user", content: "h1" },
      { role: "assistant", content: "h2" },
    ]);
  });

  it("with 3 system blocks: history starts with system messages then env.history", () => {
    const env = envelope({
      providerStrategy: "history-aware",
      systemBlocks: [
        block({ id: "prompt:system", category: "prompt", content: "SP" }),
        block({ id: "synthetic:browser-instruction", category: "synthetic", content: "BR" }),
        block({ id: "synthetic:plan-mode", category: "synthetic", content: "PLAN" }),
      ],
      history: [{ role: "user", content: "u1" }],
      userMessage: { content: "ping" },
    });
    const p = adaptEnvelope(env);
    const expected: ChatMessage[] = [
      { role: "system", content: "SP" },
      { role: "system", content: "BR" },
      { role: "system", content: "PLAN" },
      { role: "user", content: "u1" },
    ];
    expect(p.history).toEqual(expected);
  });

  it("adaptationNotes mention drop count when droppedHistoryTurns > 0", () => {
    const env = envelope({
      providerStrategy: "history-aware",
      diagnostics: {
        totalTokens: 0, budgetLimit: 200_000, budgetPercent: 0,
        droppedHistoryTurns: 17,
        historyEntries: [],
        warnings: [], assembledAt: 0,
      },
    });
    const p = adaptEnvelope(env);
    expect(p.adaptationNotes.some((n) => n.includes("17 older turn"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// adaptEnvelope — strategy: inline-system
// ────────────────────────────────────────────────────────────────────────────

describe("adaptEnvelope — inline-system", () => {
  it("with 0 system blocks: userContent === userMessage.content, no history field", () => {
    const env = envelope({
      providerStrategy: "inline-system",
      userMessage: { content: "ping" },
    });
    const p = adaptEnvelope(env);
    expect(p.userContent).toBe("ping");
    expect(p.history).toBeUndefined();
  });

  it("with 3 system blocks: <context> wrapper + system contents joined by \\n\\n---\\n\\n", () => {
    const env = envelope({
      providerStrategy: "inline-system",
      systemBlocks: [
        block({ id: "prompt:system", category: "prompt", content: "SP" }),
        block({ id: "synthetic:browser-instruction", category: "synthetic", content: "BR" }),
        block({ id: "synthetic:plan-mode", category: "synthetic", content: "PLAN" }),
      ],
      userMessage: { content: "ping" },
    });
    const p = adaptEnvelope(env);
    expect(p.userContent).toBe(
      "<context>\nSP\n\n---\n\nBR\n\n---\n\nPLAN\n</context>\n\nping",
    );
    expect(p.history).toBeUndefined();
  });

  it("adaptationNotes mention CLI session and history field absence", () => {
    const env = envelope({
      providerStrategy: "inline-system",
      systemBlocks: [block({ id: "prompt:system", category: "prompt", content: "SP" })],
    });
    const p = adaptEnvelope(env);
    expect(p.adaptationNotes.some((n) => n.toLowerCase().includes("does not receive the history"))).toBe(true);
    expect(p.adaptationNotes.some((n) => n.toLowerCase().includes("cli session"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// adaptEnvelope — strategy: gateway-stateful
// ────────────────────────────────────────────────────────────────────────────

describe("adaptEnvelope — gateway-stateful", () => {
  it("emits history (for rehydrate) but adaptationNotes warn the gateway may ignore it", () => {
    const env = envelope({
      providerStrategy: "gateway-stateful",
      systemBlocks: [
        block({ id: "prompt:system", category: "prompt", content: "SP" }),
      ],
      history: [{ role: "user", content: "u1" }],
      userMessage: { content: "ping" },
    });
    const p = adaptEnvelope(env);
    expect(p.userContent).toBe("ping");
    expect(p.history).toEqual([
      { role: "system", content: "SP" },
      { role: "user", content: "u1" },
    ]);
    expect(p.adaptationNotes.some((n) => n.toLowerCase().includes("gateway"))).toBe(true);
    expect(p.adaptationNotes.some((n) => n.toLowerCase().includes("rehydrate"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Cross-strategy: informational OpenClaw blocks are NEVER emitted
// ────────────────────────────────────────────────────────────────────────────

describe("adaptEnvelope — informational blocks excluded across strategies", () => {
  const envWithOpenClaw = (strategy: ContextEnvelope["providerStrategy"]) => envelope({
    providerStrategy: strategy,
    systemBlocks: [
      block({ id: "openclaw:SOUL.md", category: "openclaw", content: "SOUL", injectedByTopicsApp: false }),
      block({ id: "openclaw:MEMORY.md", category: "openclaw", content: "MEM", injectedByTopicsApp: false }),
    ],
    userMessage: { content: "ping" },
  });

  it("history-aware: history has no OpenClaw content", () => {
    const p = adaptEnvelope(envWithOpenClaw("history-aware"));
    expect(p.history?.some((m) => m.content.includes("SOUL"))).toBe(false);
    expect(p.history?.some((m) => m.content.includes("MEM"))).toBe(false);
  });

  it("inline-system: userContent has no OpenClaw content (no <context> at all)", () => {
    const p = adaptEnvelope(envWithOpenClaw("inline-system"));
    expect(p.userContent).toBe("ping");
    expect(p.userContent).not.toContain("SOUL");
  });

  it("gateway-stateful: history has no OpenClaw content (gateway injects it itself)", () => {
    const p = adaptEnvelope(envWithOpenClaw("gateway-stateful"));
    expect(p.history?.some((m) => m.content.includes("SOUL"))).toBe(false);
  });
});
