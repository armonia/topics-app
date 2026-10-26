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

test("the group leader stays verifiable after its command leaves a child behind", async () => {
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
  const record = {
    processId, ownerKey: "session-orphan", cardId: "card-orphan", topicId: "topic-orphan",
    pgid: identity.pgid, leaderPid: identity.pid, leaderStartTime: identity.startTime,
    startedAt: new Date().toISOString(),
  };
  registerCommandProcessGroup(record);

  let childIdentity: ReturnType<typeof readProcessGroupIdentity> = null;
  try {
    const childDeadline = Date.now() + 5_000;
    while (!existsSync(childPath) && Date.now() < childDeadline) await Bun.sleep(50);
    expect(existsSync(childPath)).toBe(true);
    const childPid = Number(readFileSync(childPath, "utf8").trim());
    childIdentity = readProcessGroupIdentity(childPid);
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

// Chiusa appena nata, come una Stop subito dopo il Run: il TERM può arrivare
// fra il trap del leader e l'exec del comando, dove prima si perdeva e il
// gruppo viveva fino al SIGKILL dopo la grazia.
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
