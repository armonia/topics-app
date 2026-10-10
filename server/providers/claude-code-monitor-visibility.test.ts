/**
 * A MONITOR IS VISIBLE WHILE IT RUNS, AND EACH OF ITS WAKES NAMES ITSELF.
 *
 * The replay is a real chat (33966f4e, 30/09 20:53-21:14Z, CLI 2.1.285),
 * anonymised (`tests/fixtures/claude-cli-2.1.285-monitor-wakes.*`): the stdout
 * the server read from the broker store, each line dated, and the notification
 * lines the CLI wrote to its own transcript at the start of each turn. A turn
 * that is itself a wake arms the Monitor "render: batch 4 results" next to two
 * older Monitors and a verifier Agent; nine wakes follow (Monitor events and
 * expiries, Agent reports); the Monitor expires at 21:13:53Z.
 *
 * What the chat got before this file: the Monitor listed as a plain
 * `local_bash` with no running time, and every wake labelled with the Monitor
 * armed LAST ("render: batch 4 results"), seven of the nine wrongly, without
 * the event's text.
 * @covers BGVIS-06
 * @covers MONITOR-03
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";
import { claudeTranscriptPath } from "../lib/claude-transcript-path";
import type { StreamHandler } from "./types";

const FIXTURES = join(import.meta.dir, "..", "..", "tests", "fixtures");
type Dated = { at: number; preamble?: true; event: Record<string, unknown> };
const STDOUT: Dated[] = readFileSync(join(FIXTURES, "claude-cli-2.1.285-monitor-wakes.ndjson"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const PROMPTS: Array<{ message: { content: string } } & Record<string, unknown>> = readFileSync(join(FIXTURES, "claude-cli-2.1.285-monitor-wakes.transcript.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const SK = "topic:monvis";
const MONITOR = "render: batch 4 results";

function makeProvider() {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const pp: Record<string, unknown> = {
    proc: { stdin: { write() { return true; }, end() {} }, kill() {}, on() {}, stdout: { on() {} }, stderr: { on() {} } },
    readline: { on() {}, close() {} },
    io: { writeStdin: () => {}, signal: () => {}, kill: () => {} },
    ready: Promise.resolve(),
    sessionKey: SK,
    consumedOffset: 0,
    stderrBuf: "",
    spawnMeta: { claudeSessionId: "test-session", isNewSession: false },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    alive: true,
    streamHandler: null,
    pendingResolve: null,
    pendingReject: null,
    fullText: "",
    activeToolCalls: new Set(),
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    lastEventAt: Date.now(),
    needsHistoryReplay: false,
    sidechain: new SidechainTracker(),
    pendingInputs: new Map(),
  };
  (provider as unknown as { processes: Map<string, unknown> }).processes.set(SK, pp);
  return { provider, pp };
}

function handler(): StreamHandler {
  return { onTextDelta() {}, onToolStart() {}, onToolResult() {}, onDone() {}, onError() {} };
}

type Point = { at: number; turnOpen: boolean; tasks: Array<{ type: string; description: string; startedAt?: number }> };
type Wake = { at: number; source: unknown };

/**
 * Feeds the recording through the provider as the server would: each wake is
 * adopted (the route's `mode: "woken"`), the one turn a person asked for gets
 * its handler first, and the CLI's transcript grows by the prompt of each turn
 * as the turn starts, as the CLI writes it. `withTranscript: false` leaves the
 * transcript out, for what stdout alone can say.
 */
function replay(withTranscript: boolean): { points: Point[]; wakes: Wake[]; provider: ClaudeCodeProvider } {
  const { provider, pp } = makeProvider();
  const wakes: Wake[] = [];
  let now = 0;
  ClaudeCodeProvider.observeWokenTurns((sk, source) => {
    wakes.push({ at: now, source });
    provider.adoptWokenTurn(sk, handler());
    return true;
  });
  const transcript = claudeTranscriptPath("/work/project", "00000000-0000-4000-8000-0000000000a1");
  mkdirSync(dirname(transcript), { recursive: true });
  rmSync(transcript, { force: true });
  const points: Point[] = [];
  let turn = -1;
  for (const { at, preamble, event } of STDOUT) {
    now = at;
    setSystemTime(new Date(at));
    if (event.type === "system" && event.subtype === "init") {
      turn++;
      const prompt = PROMPTS[turn];
      if (withTranscript) appendFileSync(transcript, JSON.stringify(prompt) + "\n");
      // The one turn a person typed: the route registered its handler before writing it.
      if (!prompt.message.content.startsWith("<task-notification>")) pp.streamHandler = handler();
    }
    pp.replayMute = preamble === true;
    (provider as unknown as { handleStreamEvent(pp: unknown, e: unknown): void }).handleStreamEvent(pp, event);
    pp.replayMute = false;
    const detail = provider.backgroundWorkDetail(SK);
    points.push({ at, turnOpen: pp.streamHandler != null, tasks: detail?.tasks ?? [] });
  }
  return { points, wakes, provider };
}

const at = (iso: string) => Date.parse(iso);
const monitorIn = (p: Point) => p.tasks.find((t) => t.description === MONITOR);

let home = "";
const realHome = process.env.HOME;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "monvis-home-"));
  process.env.HOME = home;
});
afterAll(() => {
  // bun caches `homedir()`, so the transcript may sit under the real home: its folder goes too.
  rmSync(dirname(claudeTranscriptPath("/work/project", "00000000-0000-4000-8000-0000000000a1")), { recursive: true, force: true });
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});
afterEach(() => {
  setSystemTime();
  ClaudeCodeProvider.observeWokenTurns(() => false);
});

describe("a Monitor in a real chat, replayed through the provider", () => {
  test("it is named as a Monitor with its running time while the turn that armed it is open, after it, across wakes, and gone when it expires", () => {
    const { points } = replay(true);
    // The CLI lists the task, then says which tool call started it: from that line on it is a Monitor.
    const listed = points.findIndex((p) => monitorIn(p));
    const armed = points.findIndex((p) => monitorIn(p)?.type === "monitor");
    expect(listed).toBeGreaterThan(-1);
    expect(armed).toBe(listed + 1);
    // Armed inside a turn (itself a wake), which is still open.
    expect(points[armed].turnOpen).toBe(true);
    expect(monitorIn(points[armed])).toEqual({ type: "monitor", description: MONITOR, startedAt: points[listed].at });
    // Its neighbours armed before the fragment are Monitors too; the verifier is an Agent.
    const mid = points.find((p) => p.tasks.some((t) => t.description === "Verify render v131"))!;
    expect(mid.tasks.map((t) => `${t.type}:${t.description}`).sort()).toEqual([
      "local_agent:Verify render v131", "monitor:render: batch 4 results", "monitor:render: final progress", "monitor:render: retry progress",
    ]);

    // From the arming to the expiry, every point names it, turn open or not, with the same start.
    const expiry = at("2026-09-30T21:13:53.000Z");
    const during = points.slice(armed).filter((p) => p.at < expiry - 1000);
    expect(during.some((p) => !p.turnOpen)).toBe(true);
    expect(during.some((p) => p.turnOpen && p.at > at("2026-09-30T21:02:42.000Z"))).toBe(true);
    for (const p of during) expect(monitorIn(p)).toEqual({ type: "monitor", description: MONITOR, startedAt: points[listed].at });

    // The expiry empties the list: nothing is named any more.
    expect(points.at(-1)!.tasks).toEqual([]);
  });

  test("each wake names what woke it, read off the CLI's own notification, with the event's text", () => {
    const { wakes } = replay(true);
    const byTime = wakes.map((w) => [new Date(w.at).toISOString().slice(11, 19), w.source]);
    expect(byTime).toEqual([
      ["20:53:48", [{ source: "monitor", label: "render: batch 3 results", text: "[Monitor expired after 15m with 1 event delivered. Re-arm it if you still need the watch.]" }]],
      ["20:57:52", [{ source: "monitor", label: "render: final progress", text: "[Monitor expired after 30m with 2 events delivered. Re-arm it if you still need the watch.]" }]],
      ["20:57:56", [{ source: "monitor", label: "render: final progress", text: "error" }]],
      ["20:58:21", [{ source: "task", label: 'Agent "Verify render v131" finished' }]],
      ["20:59:06", [{ source: "monitor", label: "render: retry progress", text: "[Monitor expired after 30m with 2 events delivered. Re-arm it if you still need the watch.]" }]],
      ["20:59:11", [{ source: "monitor", label: "render: retry progress", text: "[new] v130" }]],
      ["21:02:42", [{ source: "monitor", label: MONITOR, text: "[new] v133 ok in 229s" }]],
      ["21:02:59", [{ source: "task", label: 'Agent "Verify render v132" finished' }]],
      ["21:09:01", [{ source: "task", label: 'Agent "Verify render v133" finished' }]],
      ["21:13:53", [{ source: "monitor", label: MONITOR, text: "[Monitor expired after 20m with 3 events delivered. Re-arm it if you still need the watch.]" }]],
    ]);
  });

  test("with no transcript, a wake is named only when stdout says which task: never after the Monitor armed last", () => {
    const { wakes } = replay(false);
    // A server older than the source handed a bare label (the Monitor armed last): shown as it was.
    const labels = wakes.map((w) => (Array.isArray(w.source) ? w.source.map((s: { label: string }) => s.label).join(" + ") : String(w.source ?? "")) || "(unnamed)");
    expect(labels).toEqual([
      "render: batch 3 results", // its expiry printed a task_notification
      "render: final progress", // idem
      "(unnamed)", // an event: nothing on stdout says which Monitor
      "Verify render v131",
      "render: retry progress",
      "(unnamed)", // retry's event after its own expiry: guessing "the one Monitor left" would name batch 4
      "(unnamed)",
      "Verify render v132",
      "Verify render v133",
      MONITOR,
    ]);
  });
});
