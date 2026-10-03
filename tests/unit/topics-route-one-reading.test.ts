/**
 * MSEL-06, the one-reading scenario (tasks 1.2).
 *
 * The same `null` preference and the same target must give the same route in
 * every reader: the menu, the send gate, the chat resolver, the identity of a
 * dispatched topic, the dispatcher's reuse gate and the automatic picker. Each
 * row below runs the real reader, not a copy of its rule. The scope decides
 * the default (chat ON, card OFF), so the table is run once per scope.
 *
 * A second test runs the `git grep` of design §2.1 and fails when a file that
 * mentions the preference is neither a reader below nor a passage that copies
 * the value as it is, and when a reader grows its own `!!`, `?? false` or `if`.
 *
 * @covers MSEL-06
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ProvidersSnapshot } from "../../shared/types";
import {
  effectiveTopicsRouting, reusedSessionRouteConflict, reusedSessionRouting, taskModelMatchesSession,
  taskProviderForModel, topicsRoute, topicsRoutingAvailable,
} from "../../shared/task-coding-models";
import { resolveTopicProvider } from "../../server/providers/resolve-topic-provider";
import { dispatchTopicBinding, resolveDispatchTopicIdentity } from "../../server/services/dispatch-topic-identity";
import { pickAutomaticTaskModel } from "../../server/services/task-auto-model";
import type { AIProvider } from "../../server/providers/types";
import { boardTopicsRoutingEnabled, chatRouteTarget, chatTopicsRoute, surfaceTopicsRoutingEnabled, topicsRoutingBlocked } from "../../client/src/lib/topicsRoutingGate";

const at = "2026-10-03T00:00:00Z";
const entry = (name: string, models: string[]) => ({ name, label: name, status: "ready" as const, isDefault: false, models, capabilities: ["coding-tasks"], requirements: [], fetchedAt: at });
const SNAPSHOT: ProvidersSnapshot = {
  providers: [entry("claude-code", ["claude-opus-5-5", "claude-haiku-4-5"]), entry("codex", ["gpt-6.1-sol"]), entry("topics", ["claude-opus-5-5", "claude-haiku-4-5-20251001"])],
  defaultProvider: "claude-code",
  generatedAt: at,
};
const VALUE = "claude-code:claude-opus-5-5";
const target = { provider: "claude-code", model: "claude-opus-5-5" };
const native = { name: "topics", connected: true } as AIProvider;
const claudeCode = { name: "claude-code", connected: true } as AIProvider;
const registry = {
  getProvider: (name: string) => (name === "topics" ? native : claudeCode),
  getDefaultProvider: () => claudeCode,
  getTopicsModels: () => ["claude-opus-5-5"],
};
type Via = "topics" | "direct" | "pending";

describe("one reading, the same route in every reader", () => {
  test("chat scope: a null preference reads ON, and every chat reader sends Opus through the engine", () => {
    const expected = topicsRoute(null, target, SNAPSHOT, "chat").via;
    expect(expected).toBe("topics");
    const readers: Record<string, Via> = {
      effectiveTopicsRouting: effectiveTopicsRouting(null, null, "chat") && topicsRoutingAvailable(target.provider, target.model, SNAPSHOT) ? "topics" : "direct",
      topicsRoutingAvailable: topicsRoutingAvailable(target.provider, target.model, SNAPSHOT) ? "topics" : "direct",
      resolveTopicProvider: resolveTopicProvider({ ...target, topicsRouting: null }, registry).name === "topics" ? "topics" : "direct",
      chatTopicsRoute: chatTopicsRoute(null, target, undefined, SNAPSHOT).via === "topics" ? "topics" : "direct",
      // The send gate never blocks this send: the turn goes, through the engine.
      topicsRoutingBlocked: topicsRoutingBlocked(null, target, undefined, SNAPSHOT) ? "direct" : "topics",
    };
    for (const [reader, via] of Object.entries(readers)) expect([reader, via]).toEqual([reader, expected]);
  });

  // Automatic with a model pinned (what `/model` writes): the server and the
  // chip/band must judge the same target. A null preference resolves the
  // default first, so an API or Codex default stays where it is.
  test("chat scope, no provider and a pinned model: the server and the chip/band take the same route", () => {
    const api = { ...entry("claude", ["claude-opus-5-5"]), capabilities: [] };
    const rows: Array<[string, boolean | null, string, string, Via]> = [
      ["/model opus, default Claude API", null, "claude-opus-5-5", "claude", "direct"],
      ["/model opus, default Codex", null, "claude-opus-5-5", "codex", "direct"],
      ["/model haiku-3-5 (not served), default Claude Code", null, "claude-haiku-3-5", "claude-code", "direct"],
      ["/model opus, default Claude Code", null, "claude-opus-5-5", "claude-code", "topics"],
      // A card topic the engine picked: the switch written ON, no runtime pinned.
      ["written ON, opus, default Claude API", true, "claude-opus-5-5", "claude", "topics"],
    ];
    for (const [label, stored, model, def, expected] of rows) {
      const snapshot: ProvidersSnapshot = {
        providers: [...SNAPSHOT.providers, api].map((row) => ({ ...row, isDefault: row.name === def })),
        defaultProvider: def,
        generatedAt: at,
      };
      const providers = { ...registry, getDefaultProvider: () => ({ name: def, connected: true } as AIProvider) };
      const server = resolveTopicProvider({ provider: null, model, topicsRouting: stored }, providers).name === "topics" ? "topics" : "direct";
      const chip = chatTopicsRoute(stored, null, undefined, snapshot, model).via === "topics" ? "topics" : "direct";
      const band = topicsRoute(stored, chatRouteTarget(stored, null, undefined, snapshot, model), snapshot, "chat").via === "topics" ? "topics" : "direct";
      expect([label, server, chip, band]).toEqual([label, expected, expected, expected]);
    }
  });

  test("task scope: a null preference reads OFF, and every card reader runs Opus direct on Claude Code", async () => {
    const expected = topicsRoute(null, target, SNAPSHOT, "task").via;
    expect(expected).toBe("direct");
    const effective = effectiveTopicsRouting(null, VALUE, "task");
    // The classifier votes Opus on Claude Code; the route of the pick is what the topic identity makes of it.
    const plan = await pickAutomaticTaskModel({ text: "t" }, undefined, {
      snapshot: SNAPSHOT, topicsRouting: effective, codexModels: () => [],
      getProvider: () => ({ connected: true, complete: async () => ({ content: '{"provider":"claude-code","model":"claude-opus-5-5","effort":"medium","weight":"light"}' }) }) as unknown as AIProvider,
    });
    const readers: Record<string, Via> = {
      effectiveTopicsRouting: effective ? "topics" : "direct",
      taskProviderForModel: taskProviderForModel(VALUE, SNAPSHOT, effective) === "topics" ? "topics" : "direct",
      resolveDispatchTopicIdentity: resolveDispatchTopicIdentity({ provider: "claude-code", model: "claude-opus-5-5", topicsRouting: null }, SNAPSHOT).executor === "topics" ? "topics" : "direct",
      dispatchTopicBinding: dispatchTopicBinding({ model: "claude-opus-5-5", topicsRouting: null }, "claude-code", SNAPSHOT).provider === "topics" ? "topics" : "direct",
      reusedSessionRouting: reusedSessionRouting(VALUE, { topicsRouting: null }, null) ? "topics" : "direct",
      reusedSessionRouteConflict: reusedSessionRouteConflict(VALUE, { provider: "claude-code", topicsRouting: null }, null) === null ? expected : "topics",
      taskModelMatchesSession: taskModelMatchesSession(VALUE, { provider: "claude-code", model: "claude-opus-5-5", topicsRouting: null }, null) ? expected : "topics",
      pickAutomaticTaskModel: resolveDispatchTopicIdentity({ provider: plan.provider, model: plan.model, topicsRouting: null }, SNAPSHOT).executor === "topics" ? "topics" : "direct",
      surfaceTopicsRoutingEnabled: surfaceTopicsRoutingEnabled(null, null, VALUE, null) ? "topics" : "direct",
      boardTopicsRoutingEnabled: boardTopicsRoutingEnabled(null, null) ? "topics" : "direct",
    };
    for (const [reader, via] of Object.entries(readers)) expect([reader, via]).toEqual([reader, expected]);
  });
});

// Design §2.1: every file that mentions the preference, by role. A file that
// shows up and is in neither list is a reader nobody routed through topicsRoute.
const READERS = new Set([
  "shared/task-coding-models.ts",            // topicsRoute itself and the readers it serves
  "server/providers/resolve-topic-provider.ts",
  "server/services/dispatch-topic-identity.ts",
  "server/services/task-auto-model.ts",
  "server/services/task-dispatcher.ts",
  "client/src/lib/topicsRoutingGate.ts",
  "client/src/components/Chat/ProviderModelPicker.tsx",
  "client/src/components/Shared/ModelSelector/ModelList.tsx",
  "client/src/components/Modals/TopicSettingsModal.tsx",
  "client/src/components/Board/Card.tsx",
]);
const PASSAGES = new Set([
  "server/providers/topic-provider-resolver.ts", "server/lib/session-control-core.ts", "server/routes/fork.ts",
  "server/utils.ts", "server/services/tasks.ts", "server/routes/topics.ts", "server/routes/tasks-board.ts",
  "server/routes/task-patch.ts", "server/routes/chat.ts", "server/services/task-shapes.ts", "server.ts",
  "shared/board.ts", "shared/types.ts", "client/src/types/index.ts", "client/src/lib/board.ts",
  "client/src/hooks/useCardBoardSettings.ts", "client/src/components/Board/BoardSettingsPanel.tsx",
  "client/src/components/Board/FloatingTaskComposer.tsx", "client/src/components/Board/KanbanBoardPane.tsx",
  "client/src/components/Board/TaskDetail.tsx", "client/src/components/Chat/ChatInput.tsx", "client/src/components/Chat/ChatPane.tsx",
]);
/** Boolean coercions of the preference that are not readings: a write that
 *  normalises a request body, and a flag already resolved by its caller. */
const ALLOWED_COERCIONS = [
  "server/routes/topics.ts:topic.topicsRouting = body.topicsRouting === null ? null : !!body.topicsRouting;",
  "server/services/task-auto-model.ts:const viaEngine = !!deps.topicsRouting && restrictedProvider !== 'topics';",
];

describe("the closed list of design §2.1", () => {
  const root = join(import.meta.dir, "../..");
  const search = (args: string[]) => {
    try { return execFileSync("git", ["grep", ...args, "--", "server", "shared", "client/src", "server.ts", ":!*.test.*", ":!**/fixtures.ts"], { cwd: root, encoding: "utf8" }); }
    catch (error) { return (error as { stdout?: string }).stdout ?? ""; }
  };

  test("every file that mentions the preference is a reader or a passage", () => {
    const files = search(["-lE", "topicsRouting|TopicsRouting"]).split("\n").filter(Boolean);
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((file) => !READERS.has(file) && !PASSAGES.has(file))).toEqual([]);
  });

  test("no reader keeps its own !!, ?? false or if on the stored value", () => {
    const hits = search(["-nE", "!!\\s*[A-Za-z_.?]*topicsRouting|topicsRouting\\s*\\?\\?\\s*(false|true)|if\\s*\\(\\s*[A-Za-z_.?]*\\.topicsRouting\\s*\\)"])
      .split("\n").filter(Boolean)
      .map((line) => { const [file, , ...rest] = line.split(":"); return `${file}:${rest.join(":").trim()}`; });
    expect(hits.filter((hit) => !ALLOWED_COERCIONS.includes(hit))).toEqual([]);
  });
});
