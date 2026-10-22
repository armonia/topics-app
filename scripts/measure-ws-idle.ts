#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { WebSocket } from "ws";
import { CLIENT_CAPABILITIES, CLIENT_PROTOCOL_VERSION, CLIENT_VERSION } from "../client/src/schemas/ws-handshake";

const ROOT = resolve(import.meta.dir, "..");
const PORT_BASE = 15300;
const PORT_SPAN = 500;
const hash = [...ROOT].reduce((n, c) => Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const port = PORT_BASE + hash % PORT_SPAN;
const args = process.argv.slice(2);
const readNumber = (flag: string): number | undefined => {
  const at = args.indexOf(flag);
  const raw = at >= 0 ? args[at + 1] : args.find((arg) => arg.startsWith(`${flag}=`))?.split("=")[1];
  const value = Number(raw);
  return raw === undefined || !Number.isFinite(value) ? undefined : value;
};
const budget = readNumber("--budget");
const duration = readNumber("--duration") ?? 60;
if (budget === undefined || budget < 0 || duration < 20) {
  console.error("uso: bun run measure:ws-idle -- --budget <byte/s> [--duration secondi, minimo 20]");
  process.exit(2);
}
if (port === 3333) process.exit(2);

const dataDir = `/tmp/topics-ws-idle-${port}`;
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
// `start-test-server.sh` owns HOME and sets it to DATA_DIR/.home.
const home = join(dataDir, ".home");
const projectsDir = join(home, ".claude", "projects");
mkdirSync(projectsDir, { recursive: true });
// Sized on the production census read on 14/10/2026: 114 sessions, 12 of them
// active, about 370 B each, 46 KB per `external-sessions` frame. With the 20
// sessions first written here a frame was a quarter of that, and the bench
// came out green while production idled at several KB/s.
const EXTERNAL_SESSIONS = 100;
const ACTIVE_AT_START = 12;
/** Sessions that flip state on every tick: a few, as in production, not half the census. */
const FLIPS_PER_TICK = 4;
const external = Array.from({ length: EXTERNAL_SESSIONS }, (_, index) => {
  const sessionId = `ws-idle-session-${String(index).padStart(2, "0")}`;
  const dir = join(projectsDir, `fixture-${String(index).padStart(2, "0")}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const cwd = join(dataDir, "external-workspaces", `project-${index}`);
  mkdirSync(cwd, { recursive: true });
  const facts = JSON.stringify({ cwd, gitBranch: `daily/fixture-${index}`, entrypoint: "cli", isSidechain: false });
  writeFileSync(path, `${facts}\n`);
  return { index, path, facts };
});
const activeState = Array.from({ length: external.length }, (_, index) => index < ACTIVE_AT_START);
const touch = (index: number, now: number) => {
  const mtime = activeState[index] ? now : now - 16 * 60_000;
  utimesSync(external[index]!.path, mtime / 1000, mtime / 1000);
};
const startedAt = Date.now();
for (const session of external) touch(session.index, startedAt);

const fakeCli = resolve(ROOT, "tests/e2e/helpers/fake-claude-slow-turn.ts");
const cliVersions = join(home, ".local", "share", "claude", "versions");
mkdirSync(cliVersions, { recursive: true });
const cliPath = join(cliVersions, "999.0.0-e2e");
writeFileSync(cliPath, `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" "$@"\n`);
chmodSync(cliPath, 0o755);

const child = spawn("bash", [resolve(ROOT, "scripts/start-test-server.sh")], {
  cwd: ROOT,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    BUN_PORT: String(port),
    DATA_DIR: dataDir,
    TOPICS_HOME: `${dataDir}/.topics-home`,
    OPENCLAW_DIR: `${dataDir}/.openclaw`,
    HOME: home,
    TOPICS_PTY_SOCKET: `/tmp/topics-pty-bridge-ws-idle-${port}.sock`,
    TOPICS_AI_BRIDGE_SOCKET: `/tmp/topics-ai-bridge-ws-idle-${port}.sock`,
    TOPICS_E2E: "1",
    TOPICS_AI_BRIDGE: "0",
    NO_TLS: "1",
  },
});
let serverLog = "";
child.stdout?.on("data", (data: Buffer) => { serverLog += data.toString(); });
child.stderr?.on("data", (data: Buffer) => { serverLog += data.toString(); });
let stopped = false;
function stop(): void {
  if (stopped) return;
  stopped = true;
  try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* process already gone */ }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  rmSync(dataDir, { recursive: true, force: true });
}
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(130); });

async function waitForServer(): Promise<boolean> {
  const until = Date.now() + 40_000;
  while (Date.now() < until) {
    try { await fetch(`http://127.0.0.1:${port}/api/health`); return true; } catch { /* server still starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

if (!(await waitForServer())) {
  console.error(`server banco non pronto sulla porta ${port}\n${serverLog.slice(-1500)}`);
  process.exit(2);
}

const base = `http://127.0.0.1:${port}`;
const externalResponse = await fetch(`${base}/api/external-sessions`);
const externalPayload = await externalResponse.json() as { sessions?: Array<{ state: string }> };
const activeSessions = externalPayload.sessions?.filter((session) => session.state === "active").length ?? 0;
if (!externalResponse.ok || externalPayload.sessions?.length !== EXTERNAL_SESSIONS || activeSessions !== ACTIVE_AT_START) {
  console.error(`scanner sessioni: attese ${EXTERNAL_SESSIONS} totali e ${ACTIVE_AT_START} attive, trovate ${externalPayload.sessions?.length ?? 0} totali e ${activeSessions} attive`);
  process.exit(2);
}
console.log(`scanner reale: ${EXTERNAL_SESSIONS} transcript riconosciuti, ${activeSessions} attivi`);
const projectPath = join(dataDir, "chat-project");
mkdirSync(projectPath, { recursive: true });
const topicResponse = await fetch(`${base}/api/topics`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "WebSocket idle chat pipeline", projectPath, provider: "claude-code" }),
});
if (!topicResponse.ok) {
  console.error(`non riesco a creare la chat fixture: ${topicResponse.status} ${(await topicResponse.text()).slice(0, 300)}`);
  process.exit(2);
}
const created = await topicResponse.json() as { id: string; sessionKey?: string };
const topicsResponse = await fetch(`${base}/api/topics`);
const topicsPayload = await topicsResponse.json() as { topics?: Record<string, { id: string; sessionKey: string }> };
const topic = Object.values(topicsPayload.topics ?? {}).find((candidate) => candidate.id === created.id);
const sessionKey = created.sessionKey ?? topic?.sessionKey;
if (!sessionKey) {
  console.error("la topic fixture non espone sessionKey");
  process.exit(2);
}

// The frames a turn sends only to the windows holding its topic. Written out on purpose: the
// bench checks OUTBOUND_FRAME_CLASSES, so it cannot take its expectation from that table.
const TOPIC_ONLY_FRAMES = new Set([
  "stream:alive", "stream:catchup", "stream:command-answer", "stream:compaction", "stream:content_chunk",
  "stream:context", "stream:error", "stream:resumed", "stream:retry", "stream:slow",
  "stream:thinking_start", "stream:thinking_chunk", "stream:thinking_end",
  "stream:tool_call", "stream:tool_detail", "stream:tool_permission_required", "stream:tool_permission_resolved",
  "stream:tool_result", "stream:tool_update", "stream:tool_usage", "stream:tool_user_input_required",
  "stream:usage", "message:media", "command-run:updated", "typing",
]);
const initialCounts = new Map<string, number>();
const measuredCounts = new Map<string, number>();
const measuredFrames = new Map<string, number>();
let initialBytes = 0;
let measuredBytes = 0;
let streamError = "";
let inRegime = false;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const holder = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let holderChunks = 0;
holder.on("message", (data) => {
  try { if (JSON.parse(String(data))?.type === "stream:content_chunk") holderChunks += 1; } catch { /* non-JSON frame */ }
});
const opened = new Promise<void>((resolveOpen, reject) => {
  ws.on("message", (data) => {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    let type = "binary";
    let reason: unknown;
    try { ({ type = "json", reason } = JSON.parse(raw.toString("utf8")) ?? {}); } catch { /* non-JSON frame */ }
    // stream:error now reaches only the topic's windows; the global stream:end still says how the turn ended.
    if (type === "stream:error" || (type === "stream:end" && reason === "error")) streamError = raw.toString("utf8");
    const counts = inRegime ? measuredCounts : initialCounts;
    counts.set(type, (counts.get(type) ?? 0) + raw.byteLength);
    if (inRegime) {
      measuredBytes += raw.byteLength;
      measuredFrames.set(type, (measuredFrames.get(type) ?? 0) + 1);
    }
    else initialBytes += raw.byteLength;
  });
  ws.once("error", reject);
  ws.once("open", resolveOpen);
});

try {
  await opened;
  // Same handshake and focus state as useWebSocket. With no pane open its
  // focus key is already `none`, so the app sends no focus frame.
  ws.send(JSON.stringify({
    type: "hello",
    clientVersion: CLIENT_VERSION,
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    capabilities: Array.from(CLIENT_CAPABILITIES),
  }));
  ws.send(JSON.stringify({ type: "presence:announce", windowId: "ws-idle-window", topicIds: [] }));
  ws.send(JSON.stringify({ type: "subscribe", topicIds: [] }));
  // A second window holds the topic: its deltas prove the turn streams, so the idle window's zero is routing.
  await new Promise<void>((resolveOpen, reject) => { holder.once("open", resolveOpen); holder.once("error", reject); });
  holder.send(JSON.stringify({ type: "hello", clientVersion: CLIENT_VERSION, protocolVersion: CLIENT_PROTOCOL_VERSION, capabilities: Array.from(CLIENT_CAPABILITIES) }));
  holder.send(JSON.stringify({ type: "subscribe", topicIds: [created.id] }));
  // The app's first three seconds include welcome and initial socket snapshots;
  // they are reported separately because they are connection setup, not idle load.
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
  console.log(`avvio (3 s, handshake e snapshot iniziali): ${initialBytes} B`);
  for (const [type, count] of [...initialCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${type.padEnd(24)} ${count} B`);

  inRegime = true;
  const turn = (async () => {
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Gateway-Token": process.env.GATEWAY_TOKEN ?? "test-token" },
      body: JSON.stringify({ sessionKey, provider: "claude-code", messages: [{ role: "user", content: `SLOW:${duration + 30}:idle` }] }),
    });
    if (!response.ok || !response.body) throw new Error(`POST /api/chat ha risposto ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sse = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; sse += decoder.decode(chunk.value); }
    if (sse.includes("event: error") || sse.includes('"error"')) streamError ||= sse.slice(-800);
  })();
  turn.catch((error) => { streamError ||= error instanceof Error ? error.message : String(error); });

  let tick = 0;
  // A rotating window of FLIPS_PER_TICK sessions changes state each tick, so the
  // active count stays near ACTIVE_AT_START, like the production census.
  const updateSessions = () => {
    const now = Date.now();
    for (let k = 0; k < FLIPS_PER_TICK; k++) {
      const index = (tick * FLIPS_PER_TICK + k) % external.length;
      activeState[index] = !activeState[index];
      appendFileSync(external[index]!.path, `${external[index]!.facts}\n`);
      touch(index, now);
    }
    tick += 1;
  };
  const sessionTimer = setInterval(updateSessions, 10_000);
  await new Promise((resolveWait) => setTimeout(resolveWait, duration * 1000));
  clearInterval(sessionTimer);
  inRegime = false;
  ws.close();
  holder.close();
  stop();
  const rate = measuredBytes / duration;
  console.log(`regime ${duration}s · ${measuredBytes} B · ${rate.toFixed(1)} B/s · tetto ${budget} B/s`);
  if (streamError) throw new Error(`chat stream error: ${streamError.slice(0, 800)}`);
  if (!measuredCounts.has("stream:start")) throw new Error("chat pipeline non ha prodotto stream:start");
  if (holderChunks === 0) throw new Error("la finestra che tiene il topic non ha ricevuto stream:content_chunk");
  const externalFrameCount = measuredFrames.get("external-sessions") ?? 0;
  const topicFrameCount = [...measuredFrames.keys()]
    .filter((type) => TOPIC_ONLY_FRAMES.has(type))
    .reduce((count, type) => count + (measuredFrames.get(type) ?? 0), 0);
  console.log(`external-sessions         ${externalFrameCount} frame`);
  console.log(`frame topic               ${topicFrameCount} frame, attesi 0 · ${holderChunks} stream:content_chunk alla finestra che lo tiene`);
  for (const [type, count] of [...measuredCounts].sort((a, b) => b[1] - a[1])) {
    const frames = measuredFrames.get(type) ?? 0;
    console.log(`${type.padEnd(24)} ${count} B · ${frames} frame`);
  }
  const overBudget = rate > budget;
  const unexpectedExternalFrames = externalFrameCount !== 0;
  const unexpectedTopicFrames = topicFrameCount !== 0;
  const label = overBudget || unexpectedExternalFrames || unexpectedTopicFrames ? "ROSSO" : "verde";
  const comparison = `${rate.toFixed(1)} ${overBudget ? ">" : "≤"} ${budget} B/s`;
  const frameFailure = unexpectedExternalFrames ? ` · ${externalFrameCount} frame external-sessions, attesi 0` : "";
  const topicFailure = unexpectedTopicFrames ? ` · ${topicFrameCount} frame topic, attesi 0` : "";
  console.log(`\n${label}: ${comparison}${frameFailure}${topicFailure}`);
  process.exitCode = overBudget || unexpectedExternalFrames || unexpectedTopicFrames ? 1 : 0;
} catch (error) {
  ws.terminate();
  holder.terminate();
  stop();
  console.error(`WebSocket non misurabile: ${error instanceof Error ? error.message : String(error)}\n${serverLog.slice(-1000)}`);
  process.exitCode = 2;
}
