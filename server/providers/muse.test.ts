/**
 * Muse event mapping — unit tests.
 *
 * Focus: the router (`routeMuseEvent`) and the pure helpers around it. The
 * shapes below are the ones measured on the meta provider on 06/10
 * (`muse/WIRE.md`, `muse/fixtures/meta-tool.jsonl`): spawning the real CLI in
 * tests would need an authenticated session and a deterministic upstream,
 * neither of which is achievable here.
 *
 * @covers MUSE-02, MUSE-03
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MuseProvider,
  extractMuseTerminal,
  museHasStoredSession,
  museSessionLogExists,
  resolveMuseInvocation,
} from "./muse";
import type { StreamHandler, ToolArgs } from "./types";

interface RecordedHandler extends StreamHandler {
  text: { delta: string; full: string }[];
  starts: { id: string; name: string; args?: ToolArgs }[];
  updates: { id: string; partial: string }[];
  results: { id: string; result: string; error?: boolean }[];
  errors: string[];
  done: unknown[];
}

function makeHandler(): RecordedHandler {
  const h = {
    text: [],
    starts: [],
    updates: [],
    results: [],
    errors: [],
    done: [],
  } as unknown as RecordedHandler;
  h.onTextDelta = (text, fullText) => { h.text.push({ delta: text, full: fullText }); };
  h.onToolStart = (id, name, args) => { h.starts.push({ id, name, args }); };
  h.onToolUpdate = (id, partial) => { h.updates.push({ id, partial }); };
  h.onToolResult = (id, result, error) => { h.results.push({ id, result, ...(error ? { error } : {}) }); };
  h.onError = (err) => { h.errors.push(err); };
  h.onDone = (msg) => { h.done.push(msg); };
  return h;
}

type MuseState = {
  aborted: boolean;
  startedAt: number;
  toolTasks: Map<string, { name: string; text: string; started: boolean; closed: boolean }>;
  callToTask: Map<string, string>;
  terminal?: { status: string; text?: string; reason?: string };
};

function freshState(): MuseState {
  return { aborted: false, startedAt: Date.now(), toolTasks: new Map(), callToTask: new Map() };
}

/**
 * Push an event through `routeMuseEvent` for a synthetic session, seeding the
 * provider's session state like a live turn would. `as any` keeps the test on
 * behavior rather than re-exporting internals.
 */
function pushEvent(
  provider: MuseProvider,
  sessionKey: string,
  event: Record<string, unknown>,
  handler: StreamHandler,
  fullText = "",
): string | null {
  const p = provider as unknown as {
    sessionState: Map<string, MuseState>;
    routeMuseEvent: (sk: string, e: Record<string, unknown>, h: StreamHandler, f: string) => string | null;
  };
  if (!p.sessionState.has(sessionKey)) p.sessionState.set(sessionKey, freshState());
  return p.routeMuseEvent(sessionKey, event, handler, fullText);
}

function getState(provider: MuseProvider, sessionKey: string): MuseState {
  const p = provider as unknown as { sessionState: Map<string, MuseState> };
  return p.sessionState.get(sessionKey)!;
}

/** The measured envelope, stripped to the two keys the router reads. */
function ev(payloadType: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { payload_type: payloadType, payload };
}

function taskEv(payloadType: string, taskId: string, event: Record<string, unknown>): Record<string, unknown> {
  return ev(payloadType, { task_id: taskId, event: { task_id: taskId, ...event } });
}

describe("extractMuseTerminal", () => {
  test("completed carries the full reply text", () => {
    expect(extractMuseTerminal(
      { kind: "run_terminal", terminal: "completed", text: "hello there", reason: null },
      "run.terminal.completed",
    )).toEqual({ status: "completed", text: "hello there" });
  });

  test("failed carries the reason, and the status falls back to the suffix", () => {
    expect(extractMuseTerminal(
      { kind: "run_terminal", terminal: "failed", text: "", reason: "model blew up" },
      "run.terminal.failed",
    )).toEqual({ status: "failed", reason: "model blew up" });
    // A terminal the schema never named: the suffix is the honest status.
    expect(extractMuseTerminal({ reason: null }, "run.terminal.timeout")).toEqual({ status: "timeout" });
  });

  test("a structured reason degrades to JSON, never throws", () => {
    const t = extractMuseTerminal({ terminal: "failed", reason: { kind: "modelError" } }, "run.terminal.failed");
    expect(t.reason).toBe('{"kind":"modelError"}');
  });
});

describe("resolveMuseInvocation", () => {
  test("a stored id with its log resumes; anything else starts fresh", () => {
    expect(resolveMuseInvocation({ storedSessionId: "sid-1", logExists: true }))
      .toEqual({ mode: "resume", sessionId: "sid-1" });
    expect(resolveMuseInvocation({ storedSessionId: "sid-1", logExists: false })).toEqual({ mode: "fresh" });
    expect(resolveMuseInvocation({ storedSessionId: null, logExists: true })).toEqual({ mode: "fresh" });
  });
});

describe("museSessionLogExists", () => {
  const saved = process.env.XDG_DATA_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
  });

  test("true when the sid dir is there, false when only the root is", () => {
    const home = mkdtempSync(join(tmpdir(), "muse-log-exists-"));
    try {
      process.env.XDG_DATA_HOME = home;
      mkdirSync(join(home, "muse", "sessions", ".msp-view-v1", "sid-here"), { recursive: true });
      expect(museSessionLogExists("sid-here")).toBe(true);
      expect(museSessionLogExists("sid-gone")).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("fail-open when the sessions root itself is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "muse-log-missing-"));
    try {
      process.env.XDG_DATA_HOME = home;
      // An unrecognised layout must not silently turn every turn fresh: the
      // resume is attempted, and the mid-turn fallback converts a dead one.
      expect(museSessionLogExists("whatever")).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("museHasStoredSession", () => {
  const savedKey = process.env.META_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = savedKey;
  });

  test("true on an api key, on a stored oauth login, false otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-auth-"));
    try {
      delete process.env.META_API_KEY;
      const login = join(dir, "auth.json");
      writeFileSync(login, JSON.stringify({ providers: { meta: { mechanism: "oauth", storage: "keychain" } } }));
      expect(museHasStoredSession(login)).toBe(true);
      const empty = join(dir, "empty.json");
      writeFileSync(empty, JSON.stringify({ providers: {} }));
      expect(museHasStoredSession(empty)).toBe(false);
      expect(museHasStoredSession(join(dir, "absent.json"))).toBe(false);
      process.env.META_API_KEY = "sk-test";
      expect(museHasStoredSession(join(dir, "absent.json"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("routeMuseEvent", () => {
  test("deltas surface as text and concatenate; empty ones are dropped", () => {
    const p = new MuseProvider({ type: "muse" });
    const h = makeHandler();
    expect(pushEvent(p, "s", ev("run.output.delta", { text: "contenuto seg" }), h, "")).toBe("contenuto seg");
    expect(pushEvent(p, "s", ev("run.output.delta", { text: "naposto" }), h, "contenuto seg")).toBe("naposto");
    expect(pushEvent(p, "s", ev("run.output.delta", { text: "" }), h, "x")).toBeNull();
    expect(h.text).toEqual([
      { delta: "contenuto seg", full: "contenuto seg" },
      { delta: "naposto", full: "contenuto segnaposto" },
    ]);
  });

  test("the terminal event is recorded, not acted on (the close owns the verdict)", () => {
    const p = new MuseProvider({ type: "muse" });
    const h = makeHandler();
    pushEvent(p, "s", ev("run.terminal.failed", { terminal: "failed", reason: "boom" }), h);
    expect(getState(p, "s").terminal).toEqual({ status: "failed", reason: "boom" });
    expect(h.errors).toEqual([]);
    expect(h.done).toEqual([]);
  });

  test("run.model.configured labels the turn", () => {
    const p = new MuseProvider({ type: "muse" });
    const h = makeHandler();
    pushEvent(p, "s", ev("run.model.configured", { model_id: "muse-spark-1.3" }), h);
    const withModel = p as unknown as { sessionState: Map<string, Record<string, unknown>> };
    expect(withModel.sessionState.get("s")?.["model"]).toBe("muse-spark-1.3");
  });

  test("a tool call lives and dies by task events; the later tool.result is a dropped duplicate", () => {
    const p = new MuseProvider({ type: "muse" });
    const h = makeHandler();
    const task = "task-read-1";
    const call = "call_abc";
    pushEvent(p, "s", taskEv("task.lifecycle.proposed", task, { kind: "proposed", task_kind: "tool.read_file" }), h);
    pushEvent(p, "s", taskEv("task.lifecycle.side_effect_intent", task, {
      kind: "side_effect_intent", operation: "tool:read_file", idempotency_key: `tool:${call}`,
    }), h);
    pushEvent(p, "s", taskEv("task.lifecycle.started", task, { kind: "started" }), h);
    pushEvent(p, "s", taskEv("task.lifecycle.output", task, { kind: "output", chunk: "line1\n", final_result: false }), h);
    pushEvent(p, "s", taskEv("task.lifecycle.output", task, { kind: "output", chunk: "line2", final_result: true }), h);
    pushEvent(p, "s", taskEv("task.lifecycle.completed", task, { kind: "completed" }), h);
    // `tool.result` arrives AFTER completed (measured): same call, dropped.
    pushEvent(p, "s", ev("tool.result", {
      call_id: call, text: "line1\nline2", correlation_facts: { tool_name: "read_file", outcome: "success" },
    }), h);
    expect(h.starts).toEqual([{ id: task, name: "read_file", args: undefined }]);
    expect(h.updates).toEqual([
      { id: task, partial: "line1\n" },
      { id: task, partial: "line1\nline2" },
    ]);
    expect(h.results).toEqual([{ id: task, result: "line1\nline2" }]);
  });

  test("a tool.result with no task behind it is announced and closed at once", () => {
    const p = new MuseProvider({ type: "muse" });
    const h = makeHandler();
    pushEvent(p, "s", ev("tool.result", {
      call_id: "call_lonely", text: "42", correlation_facts: { tool_name: "read_file", outcome: "success" },
    }), h);
    expect(h.starts).toEqual([{ id: "call_lonely", name: "read_file", args: undefined }]);
    expect(h.results).toEqual([{ id: "call_lonely", result: "42" }]);
    // A repeated verdict for the same call does not double.
    pushEvent(p, "s", ev("tool.result", {
      call_id: "call_lonely", text: "42", correlation_facts: { tool_name: "read_file", outcome: "success" },
    }), h);
    expect(h.results).toHaveLength(1);
  });

  test("a non-success outcome and a failed task both report errors", () => {
    const p = new MuseProvider({ type: "muse" });
    const h = makeHandler();
    pushEvent(p, "s", ev("tool.result", {
      call_id: "call_err", text: "denied", correlation_facts: { tool_name: "exec", outcome: "error" },
    }), h);
    const task = "task-fail-1";
    pushEvent(p, "s", taskEv("task.lifecycle.proposed", task, { kind: "proposed", task_kind: "tool.exec" }), h);
    pushEvent(p, "s", taskEv("task.lifecycle.started", task, { kind: "started" }), h);
    pushEvent(p, "s", taskEv("task.lifecycle.failed", task, { kind: "failed", reason: "exit 1" }), h);
    expect(h.results).toEqual([
      { id: "call_err", result: "denied", error: true },
      { id: task, result: "exit 1", error: true },
    ]);
  });

  test("non-tool tasks and phase noise never touch the handler", () => {
    const p = new MuseProvider({ type: "muse" });
    const h = makeHandler();
    const model = "task-model-1";
    for (const [pt, event] of [
      ["task.lifecycle.proposed", { kind: "proposed", task_kind: "model.unknown.response" }],
      ["task.lifecycle.accepted", { kind: "accepted" }],
      ["task.lifecycle.scheduled", { kind: "scheduled" }],
      ["task.lifecycle.side_effect_intent", { kind: "side_effect_intent", operation: "model.unknown.response" }],
      ["task.lifecycle.started", { kind: "started" }],
      ["task.lifecycle.status", { kind: "status", message: "opening stream" }],
      ["task.lifecycle.completed", { kind: "completed" }],
    ] as const) {
      pushEvent(p, "s", taskEv(pt, model, event), h);
    }
    // A failed REMINDER is not the turn's verdict either (echo shape).
    pushEvent(p, "s", taskEv("task.lifecycle.failed", "task-reminder", { kind: "failed", reason: "no base instructions" }), h);
    for (const pt of ["runtime.command.accepted", "session.run.linked", "turn.input.user", "run.lifecycle.started", "task.stream.linked", "something.entirely.new"]) {
      pushEvent(p, "s", ev(pt, { kind: "whatever" }), h);
    }
    pushEvent(p, "s", { nope: true }, h);
    pushEvent(p, "s", ev("run.output.delta", {}), h);
    expect(h.starts).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(h.results).toEqual([]);
    expect(h.text).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  test("completed without started still lands on a row", () => {
    const p = new MuseProvider({ type: "muse" });
    const h = makeHandler();
    const task = "task-lost-start";
    pushEvent(p, "s", taskEv("task.lifecycle.proposed", task, { kind: "proposed", task_kind: "tool.write" }), h);
    pushEvent(p, "s", taskEv("task.lifecycle.completed", task, { kind: "completed" }), h);
    expect(h.starts).toEqual([{ id: task, name: "write", args: undefined }]);
    expect(h.results).toEqual([{ id: task, result: "" }]);
  });
});
