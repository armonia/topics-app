import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { writeFileAtomic } from "./atomic-write";
import { readJsonStateFile } from "./state-file";
import { resolveStateDir, stateDirTarget } from "./data-dir";

export const COMMAND_GROUP_TERM_GRACE_MS = 10_000;
const COMMAND_GROUP_CONFIRM_MS = 1_500;
const COMMAND_GROUP_POLL_MS = 100;
const DARWIN_PROC_INFO_SIZE = 136;

const darwinProcLibrary = process.platform === "darwin"
  ? dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  })
  : null;

export interface CommandProcessGroup {
  processId: string;
  ownerKey: string;
  cardId: string | null;
  topicId: string | null;
  pgid: number;
  leaderPid: number;
  leaderStartTime: string;
  startedAt: string;
  retiringAt?: string;
  stopFailed?: boolean;
}

export interface ProcessGroupIdentity {
  pid: number;
  pgid: number;
  startTime: string;
}

export interface CommandProcessGroupHooks {
  onRetiring?: (group: CommandProcessGroup) => void;
  onSettled?: (group: CommandProcessGroup, stopped: boolean) => void;
}

type GroupFile = { groups?: unknown };

const groupFolders = new Map<string, string>();
const retiringGroups = new Map<string, Promise<boolean>>();

function registryPath(): string {
  const target = stateDirTarget(process.cwd());
  let directory = groupFolders.get(target);
  if (!directory) {
    directory = join(resolveStateDir(process.cwd()), ".state");
    mkdirSync(directory, { recursive: true });
    groupFolders.set(target, directory);
  }
  return join(directory, "command-process-groups.json");
}

function validGroup(value: unknown): value is CommandProcessGroup {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<CommandProcessGroup>;
  return typeof row.processId === "string"
    && typeof row.ownerKey === "string"
    && (row.cardId === null || typeof row.cardId === "string")
    && (row.topicId === null || typeof row.topicId === "string")
    && Number.isInteger(row.pgid) && Number(row.pgid) > 0
    && Number.isInteger(row.leaderPid) && Number(row.leaderPid) > 0
    && typeof row.leaderStartTime === "string" && row.leaderStartTime.length > 0
    && typeof row.startedAt === "string";
}

function readGroups(path: string): CommandProcessGroup[] {
  const file = readJsonStateFile(path, "command-process-groups") as GroupFile | null;
  return Array.isArray(file?.groups) ? file.groups.filter(validGroup) : [];
}

function writeGroups(path: string, groups: CommandProcessGroup[]): void {
  writeFileAtomic(path, JSON.stringify({ groups }));
}

function sameGroup(a: CommandProcessGroup, b: CommandProcessGroup): boolean {
  return a.processId === b.processId
    && a.ownerKey === b.ownerKey
    && a.cardId === b.cardId
    && a.topicId === b.topicId
    && a.pgid === b.pgid
    && a.leaderPid === b.leaderPid
    && a.leaderStartTime === b.leaderStartTime
    && a.startedAt === b.startedAt;
}

export function processGroupIdentityMatches(identity: ProcessGroupIdentity): boolean {
  const live = readProcessGroupIdentity(identity.pid);
  return !!live
    && live.pid === identity.pid
    && live.pgid === identity.pgid
    && live.startTime === identity.startTime;
}

function identityMatches(group: CommandProcessGroup): boolean {
  return processGroupIdentityMatches({
    pid: group.leaderPid,
    pgid: group.pgid,
    startTime: group.leaderStartTime,
  });
}

export function readProcessGroupIdentity(pid: number): ProcessGroupIdentity | null {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const processId = Number(stat.slice(0, stat.indexOf(" ")));
      const pgid = Number(fields[2]);
      const startTime = fields[19];
      if (processId !== pid || !Number.isInteger(pgid) || !startTime) return null;
      return { pid: processId, pgid, startTime };
    }

    if (process.platform === "darwin" && darwinProcLibrary) {
      const info = Buffer.alloc(DARWIN_PROC_INFO_SIZE);
      const size = darwinProcLibrary.symbols.proc_pidinfo(pid, 3, 0, ptr(info), info.length);
      if (size < DARWIN_PROC_INFO_SIZE || info.readUInt32LE(12) !== pid) return null;
      const pgid = info.readUInt32LE(100);
      const startTime = `${info.readBigUInt64LE(120)}:${info.readBigUInt64LE(128)}`;
      if (pgid <= 0 || startTime === "0:0") return null;
      return { pid, pgid, startTime };
    }

    return null;
  } catch {
    return null;
  }
}

export function processGroupAlive(pgid: number): boolean {
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function captureProcessGroup(pid: number): ProcessGroupIdentity | null {
  if (process.platform === "win32") return null;
  const identity = readProcessGroupIdentity(pid);
  if (!identity) {
    if (processGroupAlive(pid)) throw new Error(`could not verify process group for pid ${pid}`);
    return null;
  }
  if (identity.pgid !== pid) throw new Error(`pid ${pid} did not start its own process group`);
  return identity;
}

export function registerCommandProcessGroup(group: CommandProcessGroup): void {
  if (process.platform === "win32") return;
  if (!validGroup(group) || group.pgid !== group.leaderPid) throw new Error("invalid command process group");
  const path = registryPath();
  const groups = readGroups(path).filter((row) => row.processId !== group.processId);
  groups.push(group);
  writeGroups(path, groups);
}

export function listCommandProcessGroups(): CommandProcessGroup[] {
  if (process.platform === "win32") return [];
  return readGroups(registryPath());
}

export function commandProcessGroup(processId: string): CommandProcessGroup | undefined {
  return listCommandProcessGroups().find((row) => row.processId === processId);
}

export function forgetCommandProcessGroup(processId: string): void {
  if (process.platform === "win32") return;
  const path = registryPath();
  const groups = readGroups(path).filter((row) => row.processId !== processId);
  writeGroups(path, groups);
}

export function forgetCommandProcessGroupIfGone(processId: string): boolean {
  const group = commandProcessGroup(processId);
  if (!group || processGroupAlive(group.pgid)) return false;
  forgetCommandProcessGroup(processId);
  return true;
}

function replaceGroup(path: string, expected: CommandProcessGroup, next: CommandProcessGroup | null): boolean {
  const groups = readGroups(path);
  const index = groups.findIndex((row) => row.processId === expected.processId && sameGroup(row, expected));
  if (index < 0) return false;
  if (next) groups[index] = next;
  else groups.splice(index, 1);
  writeGroups(path, groups);
  return true;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  process.kill(-pgid, signal);
}

async function waitForGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  do {
    if (!processGroupAlive(pgid)) return true;
    await Bun.sleep(COMMAND_GROUP_POLL_MS);
  } while (Date.now() < until);
  return !processGroupAlive(pgid);
}

async function closeRegisteredCommandProcessGroup(
  expected: CommandProcessGroup,
  hooks: CommandProcessGroupHooks = {},
): Promise<boolean> {
  if (process.platform === "win32") return false;
  const path = registryPath();
  const registered = readGroups(path).find((row) => row.processId === expected.processId && sameGroup(row, expected));
  if (!registered) return false;
  if (!processGroupAlive(registered.pgid)) {
    replaceGroup(path, registered, null);
    hooks.onSettled?.(registered, true);
    return true;
  }
  if (!identityMatches(registered)) {
    const failed = { ...registered, stopFailed: true, retiringAt: undefined };
    replaceGroup(path, registered, failed);
    hooks.onSettled?.(failed, false);
    return false;
  }

  const retiringAt = `${Date.now()}-${crypto.randomUUID()}`;
  const retiring = { ...registered, retiringAt, stopFailed: false };
  if (!replaceGroup(path, registered, retiring)) return false;
  hooks.onRetiring?.(retiring);
  const beforeTerm = readGroups(path).find((row) => row.processId === retiring.processId);
  if (!beforeTerm || !sameGroup(beforeTerm, retiring) || beforeTerm.retiringAt !== retiringAt) {
    const stopped = !processGroupAlive(retiring.pgid);
    hooks.onSettled?.(retiring, stopped);
    return stopped;
  }
  if (!processGroupAlive(beforeTerm.pgid)) {
    replaceGroup(path, beforeTerm, null);
    hooks.onSettled?.(beforeTerm, true);
    return true;
  }
  if (!identityMatches(beforeTerm)) {
    const failed = { ...beforeTerm, stopFailed: true, retiringAt: undefined };
    replaceGroup(path, beforeTerm, failed);
    hooks.onSettled?.(failed, false);
    return false;
  }
  try { signalGroup(retiring.pgid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      const failed = { ...retiring, stopFailed: true, retiringAt: undefined };
      replaceGroup(path, retiring, failed);
      hooks.onSettled?.(failed, false);
      return false;
    }
  }

  if (await waitForGroupExit(retiring.pgid, COMMAND_GROUP_TERM_GRACE_MS)) {
    replaceGroup(path, retiring, null);
    hooks.onSettled?.(retiring, true);
    return true;
  }

  // Re-read the same instance file and match the original entry before SIGKILL.
  const current = readGroups(path).find((row) => row.processId === retiring.processId);
  if (!current || !sameGroup(current, retiring) || current.retiringAt !== retiringAt) return false;
  if (!processGroupAlive(current.pgid)) {
    replaceGroup(path, current, null);
    hooks.onSettled?.(current, true);
    return true;
  }
  if (!identityMatches(current)) {
    const failed = { ...current, stopFailed: true, retiringAt: undefined };
    replaceGroup(path, current, failed);
    hooks.onSettled?.(failed, false);
    return false;
  }
  try { signalGroup(current.pgid, "SIGKILL"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      const failed = { ...current, stopFailed: true, retiringAt: undefined };
      replaceGroup(path, current, failed);
      hooks.onSettled?.(failed, false);
      return false;
    }
  }

  const stopped = await waitForGroupExit(current.pgid, COMMAND_GROUP_CONFIRM_MS);
  if (stopped) replaceGroup(path, current, null);
  else {
    const failed = { ...current, stopFailed: true, retiringAt: undefined };
    replaceGroup(path, current, failed);
    hooks.onSettled?.(failed, false);
    return false;
  }
  hooks.onSettled?.(current, true);
  return true;
}

export function closeCommandProcessGroup(
  expected: CommandProcessGroup,
  hooks: CommandProcessGroupHooks = {},
): Promise<boolean> {
  const existing = retiringGroups.get(expected.processId);
  if (existing) return existing;
  const retiring = closeRegisteredCommandProcessGroup(expected, hooks);
  retiringGroups.set(expected.processId, retiring);
  const clear = () => {
    if (retiringGroups.get(expected.processId) === retiring) retiringGroups.delete(expected.processId);
  };
  void retiring.then(clear, clear);
  return retiring;
}

export async function closeCommandProcessGroups(
  matches: (group: CommandProcessGroup) => boolean,
  hooks: CommandProcessGroupHooks = {},
): Promise<boolean[]> {
  const groups = listCommandProcessGroups().filter(matches);
  return Promise.all(groups.map((group) => closeCommandProcessGroup(group, hooks)));
}

export async function reconcileClosedCardProcessGroups(
  cardIsClosed: (cardId: string) => boolean,
  hooks: CommandProcessGroupHooks = {},
): Promise<boolean[]> {
  const groups = listCommandProcessGroups().filter((group) => group.cardId && cardIsClosed(group.cardId));
  return Promise.all(groups.map((group) => closeCommandProcessGroup(group, hooks)));
}
