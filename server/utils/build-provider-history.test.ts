/**
 * Unit tests for buildProviderHistory.
 *
 * Coverage focus: the four invariants the chat route relies on —
 *   (1) returns a stateless ChatMessage[] from the persisted active thread
 *   (2) excludes partial assistant turns and OpenClaw context envelopes
 *   (3) honors `excludeLast` so the just-appended user turn isn't duplicated
 *   (4) honors `limit` to cap prompt size
 *
 * Marker stripping is exercised directly so a regex regression on browser /
 * topic-switch markers can't sneak through into provider prompts.
 */

import { describe, expect, test } from "bun:test";
import { buildProviderHistory } from "./build-provider-history";
import type { StoredMessage } from "../types";

function msg(
  role: "user" | "assistant",
  content: string,
  extra: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

describe("buildProviderHistory", () => {
  test("returns user/assistant pairs in order", () => {
    const stored: StoredMessage[] = [
      msg("user", "hello"),
      msg("assistant", "hi there"),
      msg("user", "how are you?"),
    ];
    const out = buildProviderHistory(stored);
    expect(out).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you?" },
    ]);
  });

  test("returns empty array when no messages exist", () => {
    expect(buildProviderHistory([])).toEqual([]);
  });

  test("skips partial (in-flight) assistant messages", () => {
    const stored: StoredMessage[] = [
      msg("user", "tell me a joke"),
      msg("assistant", "knock", { partial: true }),
    ];
    expect(buildProviderHistory(stored)).toEqual([
      { role: "user", content: "tell me a joke" },
    ]);
  });

  test("skips OpenClaw context envelope messages", () => {
    const stored: StoredMessage[] = [
      msg("user", "real prompt"),
      msg(
        "assistant",
        "[Chat messages since your last reply: ...routing chunk...]",
      ),
      msg("assistant", "real reply"),
    ];
    const out = buildProviderHistory(stored);
    expect(out.map((m) => m.content)).toEqual(["real prompt", "real reply"]);
  });

  test("strips browser, topic-switch, and topic-new markers", () => {
    const stored: StoredMessage[] = [
      msg("user", "{{TOPIC_SWITCH:abc-123}} hi after switch"),
      msg("assistant", "look at {{BROWSER:https://example.com}} ok"),
      msg("user", "{{TOPIC_NEW:Untitled}} fresh topic"),
    ];
    const out = buildProviderHistory(stored);
    expect(out.map((m) => m.content)).toEqual([
      "hi after switch",
      "look at  ok",
      "fresh topic",
    ]);
  });

  test("strips PROJECT_OPEN / PROJECT_CREATE markers (audit #4 leak regression)", () => {
    const stored: StoredMessage[] = [
      msg("assistant", "Opening it now {{PROJECT_OPEN:Pix}} done."),
      msg("assistant", "{{PROJECT_CREATE:my-app}} scaffolded."),
    ];
    const out = buildProviderHistory(stored);
    const joined = out.map((m) => m.content).join("\n");
    expect(joined).not.toContain("{{PROJECT_OPEN");
    expect(joined).not.toContain("{{PROJECT_CREATE");
    expect(out.map((m) => m.content)).toEqual([
      "Opening it now  done.",
      "scaffolded.",
    ]);
  });

  test("drops messages that become empty after marker stripping", () => {
    const stored: StoredMessage[] = [
      msg("user", "{{TOPIC_SWITCH:abc-123}}"),
      msg("user", "actual message"),
    ];
    expect(buildProviderHistory(stored)).toEqual([
      { role: "user", content: "actual message" },
    ]);
  });

  test("excludeLast drops the final entry", () => {
    const stored: StoredMessage[] = [
      msg("user", "first"),
      msg("assistant", "ack"),
      msg("user", "just appended"),
    ];
    expect(buildProviderHistory(stored, { excludeLast: true })).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "ack" },
    ]);
  });

  test("excludeLast on empty input is a no-op (no crash)", () => {
    expect(buildProviderHistory([], { excludeLast: true })).toEqual([]);
  });

  test("limit caps to the most recent N turns", () => {
    const stored: StoredMessage[] = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
      msg("assistant", "a2"),
      msg("user", "u3"),
    ];
    const out = buildProviderHistory(stored, { limit: 2 });
    expect(out).toEqual([
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
    ]);
  });

  test("limit + excludeLast: drops last, then caps", () => {
    const stored: StoredMessage[] = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
      msg("assistant", "a2"),
      msg("user", "u3-just-appended"),
    ];
    const out = buildProviderHistory(stored, { limit: 2, excludeLast: true });
    expect(out).toEqual([
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ]);
  });

  test("preserves order across all filters", () => {
    const stored: StoredMessage[] = [
      msg("user", "{{TOPIC_NEW:t}} init"),
      msg("assistant", "[Chat messages since your last reply"), // dropped
      msg("assistant", "ok", { partial: true }), // dropped
      msg("user", "second"),
      msg("assistant", "reply"),
      msg("user", "third"),
    ];
    expect(buildProviderHistory(stored).map((m) => m.content)).toEqual([
      "init",
      "second",
      "reply",
      "third",
    ]);
  });
});
