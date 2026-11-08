/**
 * Real process-group ownership, persistence boundaries and delayed termination.
 *
 * @covers CARDPROCESS-01
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousDataDir = process.env.DATA_DIR;
const previousTopicsDataDir = process.env.TOPICS_DATA_DIR;
const previousTopicsHome = process.env.TOPICS_HOME;
const instanceA = mkdtempSync(join(tmpdir(), "topics-groups-a-"));
const instanceB = mkdtempSync(join(tmpdir(), "topics-groups-b-"));
process.env.TOPICS_DATA_DIR = instanceA;
process.env.TOPICS_HOME = `${instanceA}-home`;
delete process.env.DATA_DIR;

const {
  COMMAND_GROUP_TERM_GRACE_MS, captureProcessGroup, closeCommandProcessGroup, commandProcessGroupStopPath, processGroupAlive,
  processGroupIdentityMatches, readProcessGroupIdentity, registerCommandProcessGroup,
} = await import("./command-process-groups");
const { commandArgv, readExitCode } = await import("./command-process");
const { stopCardCommandProcesses } = await import("../routes/processes");
const live: Array<{ proc: ReturnType<typeof Bun.spawn>; pgid: number }> = [];

afterAll(async () => {
  for (const { proc, pgid } of live) {
    try { process.kill(-pgid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
  }
  await Promise.all(live.map(({ proc }) => Promise.race([proc.exited, Bun.sleep(1000)])));
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousTopicsDataDir === undefined) delete process.env.TOPICS_DATA_DIR;
  else process.env.TOPICS_DATA_DIR = previousTopicsDataDir;
  if (previousTopicsHome === undefined) delete process.env.TOPICS_HOME;
  else process.env.TOPICS_HOME = previousTopicsHome;
  rmSync(instanceA, { recursive: true, force: true });
  rmSync(instanceB, { recursive: true, force: true });
});

function startGroup(command = "exec sleep 90"): { proc: ReturnType<typeof Bun.spawn>; pgid: number; record: ReturnType<typeof makeRecord> } {
  const shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  const proc = Bun.spawn([shell, "-c", command], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
  });
  live.push({ proc, pgid: proc.pid });
  const identity = captureProcessGroup(proc.pid);
  if (!identity) throw new Error(`could not capture group for ${proc.pid}`);
  live[live.length - 1] = { proc, pgid: identity.pgid };
  return { proc, pgid: identity.pgid, record: makeRecord(identity) };
}

async function startTermResistantGroup(): Promise<{ proc: ReturnType<typeof Bun.spawn>; pgid: number; record: ReturnType<typeof makeRecord> }> {
  const proc = Bun.spawn(["/usr/bin/python3", "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(90)"], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true,
  });
  live.push({ proc, pgid: proc.pid });
  const reader = proc.stdout.getReader();
  let ready = false;
  while (!ready) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("SIGTERM test process exited before readiness");
    ready = new TextDecoder().decode(chunk.value).includes("ready");
  }
  const identity = captureProcessGroup(proc.pid);
  if (!identity) throw new Error(`could not capture group for ${proc.pid}`);
  return { proc, pgid: identity.pgid, record: makeRecord(identity) };
}

function makeRecord(
  identity: NonNullable<ReturnType<typeof captureProcessGroup>>,
  cardId: string | null = "card-a",
  ownerKey = "session-a",
  topicId: string | null = "topic-a",
) {
  return {
    processId: crypto.randomUUID(), ownerKey, cardId, topicId,
    pgid: identity.pgid, leaderPid: identity.pid, leaderStartTime: identity.startTime,
    startedAt: new Date().toISOString(),
  };
}

test("closing card A leaves the server, daemon and card B groups alive", async () => {
  const server = readProcessGroupIdentity(process.pid);
  const daemon = startGroup();
  const cliB = startGroup();
  const commandA = startGroup();
  daemon.record = { ...daemon.record, cardId: null, topicId: null };
  cliB.record = { ...cliB.record, cardId: "card-b", ownerKey: "session-b" };
  commandA.record = { ...commandA.record, cardId: "card-a", ownerKey: "session-a" };
  registerCommandProcessGroup(daemon.record);
  registerCommandProcessGroup(cliB.record);
  registerCommandProcessGroup(commandA.record);

  expect(server).not.toBeNull();
  expect(commandA.pgid).not.toBe(server!.pgid);
  expect(commandA.pgid).not.toBe(daemon.pgid);
  expect(commandA.pgid).not.toBe(cliB.pgid);
  stopCardCommandProcesses("card-a");
  await Promise.race([commandA.proc.exited, Bun.sleep(3000)]);
  expect(processGroupAlive(commandA.pgid)).toBe(false);
  expect(processGroupAlive(daemon.pgid)).toBe(true);
  expect(processGroupAlive(cliB.pgid)).toBe(true);
  expect(processGroupAlive(server!.pgid)).toBe(true);
});

/** The pid a command wrote, once it is all there: the file exists a moment before its content. */
async function writtenPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  const text = () => (existsSync(path) ? readFileSync(path, "utf8").trim() : "");
  while (!text() && Date.now() < deadline) await Bun.sleep(10);
  return Number(text());
}

// The child writes its pid only once the command is gone, reaped by the leader:
// from then on the code is 0 wherever the close's TERM lands. The command used
// to write it a moment before exiting, and a TERM in that moment ended it with
// 143, the right code for a stopped command and a red for this test (6 runs in
// 50 on a loaded Linux runner). Catching TERM in the command is no way out: the
// child it forks keeps that handler until its exec and loses the TERM there.
test("the group leader stays verifiable after its command leaves a child behind", async () => {
  const processId = crypto.randomUUID();
  const exitPath = join(instanceA, `${processId}.exit`);
  const childPath = join(instanceA, `${processId}.child`);
  const child = `while kill -0 "$PPID" 2>/dev/null; do sleep 0.01; done; echo "$$" > ${childPath}; exec sleep 90`;
  const argv = commandArgv(`/bin/sh -c '${child}' >/dev/null 2>&1 & exit 0`, exitPath, commandProcessGroupStopPath(processId));
  if (!argv) throw new Error("POSIX command shell is unavailable");
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  live.push({ proc, pgid: proc.pid });
  const identity = captureProcessGroup(proc.pid);
  if (!identity) throw new Error(`could not capture group for ${proc.pid}`);
  live[live.length - 1] = { proc, pgid: identity.pgid };
  const record = {
    processId, ownerKey: "session-orphan", cardId: "card-orphan", topicId: "topic-orphan",
    pgid: identity.pgid, leaderPid: identity.pid, leaderStartTime: identity.startTime,
    startedAt: new Date().toISOString(),
  };
  registerCommandProcessGroup(record);

  let childIdentity: ReturnType<typeof readProcessGroupIdentity> = null;
  try {
    childIdentity = readProcessGroupIdentity(await writtenPid(childPath));
    expect(childIdentity?.pgid).toBe(identity.pgid);
    expect(processGroupAlive(identity.pgid)).toBe(true);
    expect(readProcessGroupIdentity(identity.pid)).toEqual(identity);
    expect(await closeCommandProcessGroup(record)).toBe(true);
    await proc.exited;
    expect(processGroupAlive(identity.pgid)).toBe(false);
    expect(readExitCode(exitPath)).toBe(0);
  } finally {
    if (childIdentity && processGroupIdentityMatches(childIdentity)) {
      try { process.kill(childIdentity.pid, "SIGKILL"); } catch {}
    }
  }
});

// A Stop's TERM can land at any instant of the drain, the leader's wait for the
// children its command left behind: in the open of the scan's FIFO, in its read,
// in its wait. Sent to the leader alone and over and over, it lands in all of
// them. None may end the leader while a peer lives (the delayed SIGKILL checks
// the leader before it fires) or before it wrote the exit code. dash (Linux)
// used to exit on the interrupted open without writing it; zsh skipped the scan.
test("a TERM during the drain neither ends the leader early nor loses the exit code", async () => {
  const processId = crypto.randomUUID();
  const exitPath = join(instanceA, `${processId}.exit`);
  const childPath = join(instanceA, `${processId}.child`);
  const argv = commandArgv(`/bin/sh -c 'sleep 90 >/dev/null 2>&1 & echo $! > ${childPath}; exit 0'`, exitPath, commandProcessGroupStopPath(processId));
  if (!argv) throw new Error("POSIX command shell is unavailable");
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  live.push({ proc, pgid: proc.pid });
  const identity = captureProcessGroup(proc.pid);
  if (!identity) throw new Error(`could not capture group for ${proc.pid}`);
  live[live.length - 1] = { proc, pgid: identity.pgid };

  const childPid = await writtenPid(childPath);
  expect(readProcessGroupIdentity(childPid)?.pgid).toBe(identity.pgid);
  try {
    const until = Date.now() + 2_500;
    while (Date.now() < until) {
      try { process.kill(identity.pid, "SIGTERM"); } catch {}
      await Bun.sleep(1);
    }
    expect(proc.exitCode).toBeNull();
    expect(processGroupIdentityMatches(identity)).toBe(true);
  } finally {
    try { process.kill(childPid, "SIGKILL"); } catch {}
  }
  await Promise.race([proc.exited, Bun.sleep(5_000)]);
  expect(proc.exitCode).toBe(0);
  expect(readExitCode(exitPath)).toBe(0);
});

// Closed as it starts, like a Stop right after Run: the TERM can land between
// the leader's trap and the command's exec, where it used to be lost and the
// group lived until the SIGKILL after the grace.
test("a group closed as it starts ends on TERM, not on the delayed SIGKILL", async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const processId = crypto.randomUUID();
    const exitPath = join(instanceA, `${processId}.exit`);
    const stopPath = commandProcessGroupStopPath(processId);
    const argv = commandArgv("sleep 30 & sleep 30; wait", exitPath, stopPath);
    if (!argv) throw new Error("POSIX command shell is unavailable");
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    live.push({ proc, pgid: proc.pid });
    const identity = captureProcessGroup(proc.pid);
    if (!identity) throw new Error(`could not capture group for ${proc.pid}`);
    const record = {
      processId, ownerKey: "session-early", cardId: "card-early", topicId: "topic-early",
      pgid: identity.pgid, leaderPid: identity.pid, leaderStartTime: identity.startTime,
      startedAt: new Date().toISOString(),
    };
    registerCommandProcessGroup(record);
    const started = Date.now();
    expect(await closeCommandProcessGroup(record)).toBe(true);
    expect(Date.now() - started).toBeLessThan(COMMAND_GROUP_TERM_GRACE_MS);
    expect(processGroupAlive(identity.pgid)).toBe(false);
    expect(existsSync(stopPath)).toBe(false);
  }
});

test("a reused owner key cannot redirect the delayed SIGKILL to a new process", async () => {
  const old = await startTermResistantGroup();
  old.record = { ...old.record, ownerKey: "same-session" };
  registerCommandProcessGroup(old.record);
  let enteredShutdown!: () => void;
  const shutdownEntered = new Promise<void>((resolve) => { enteredShutdown = resolve; });
  const closeStarted = Date.now();
  const stop = closeCommandProcessGroup(old.record, { onRetiring: () => enteredShutdown() });
  await shutdownEntered;

  const fresh = await startTermResistantGroup();
  fresh.record = { ...fresh.record, ownerKey: "same-session", cardId: "card-b" };
  registerCommandProcessGroup(fresh.record);

  expect(await stop).toBe(true);
  expect(Date.now() - closeStarted).toBeGreaterThanOrEqual(10_000);
  expect(processGroupAlive(old.pgid)).toBe(false);
  expect(processGroupAlive(fresh.pgid)).toBe(true);
});

test("closing rechecks its registration after publishing the closing state", async () => {
  const original = startGroup();
  const replacement = startGroup();
  registerCommandProcessGroup(original.record);

  const closed = await closeCommandProcessGroup(original.record, {
    onRetiring: () => registerCommandProcessGroup({
      ...replacement.record,
      processId: original.record.processId,
    }),
  });

  expect(closed).toBe(false);
  expect(processGroupAlive(original.pgid)).toBe(true);
  expect(processGroupAlive(replacement.pgid)).toBe(true);
});

test("a second instance reconciles only its own data-directory registry", async () => {
  const first = startGroup();
  first.record = { ...first.record, cardId: "same-card-id" };
  registerCommandProcessGroup(first.record);

  process.env.TOPICS_DATA_DIR = instanceB;
  process.env.TOPICS_HOME = `${instanceB}-home`;
  const second = startGroup();
  second.record = { ...second.record, cardId: "same-card-id" };
  registerCommandProcessGroup(second.record);
  const { createProcessesRouter } = await import("../routes/processes");
  createProcessesRouter({
    db: { prepare: () => ({ get: () => ({ status: "done", archived: 0 }) }) },
    json: (data: unknown) => new Response(JSON.stringify(data)),
    broadcastToAll: () => {},
  } as never);

  await Promise.race([second.proc.exited, Bun.sleep(1000)]);
  expect(processGroupAlive(second.pgid)).toBe(false);
  expect(processGroupAlive(first.pgid)).toBe(true);
});
