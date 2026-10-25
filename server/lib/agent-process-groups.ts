import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { readJsonStateFile } from "./state-file";
import { resolveStateDir } from "./data-dir";
import { readProcessGroupId } from "./process-tree";

export type AgentProcessGroupSource = "run_command" | "run_script" | "native_bash";

export interface AgentProcessGroup {
  id: string;
  pid: number;
  pgid: number;
  pidLstart?: string;
  sessionKey: string;
  topicId: string | null;
  source: AgentProcessGroupSource;
  preserveOnOwnerClose?: boolean;
  startedAt: string;
}

export interface AgentProcessGroupRegistryDeps {
  path?: () => string;
  serverPgid?: () => Promise<number | null>;
  groupAlive?: (pgid: number) => boolean;
  signalGroup?: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  pidLstart?: (pid: number) => string | undefined;
}

function registryPath(): string {
  return join(resolveStateDir(process.cwd()), ".state", "agent-process-groups.json");
}

function readPidLstart(pid: number): string | undefined {
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { timeout: 3000, killSignal: "SIGKILL" });
    return new TextDecoder().decode(result.stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readServerPgid(): Promise<number | null> {
  return Promise.resolve(readProcessGroupId(process.pid));
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function groupSignal(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
  process.kill(-pgid, signal);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgentProcessGroupRegistry {
  private readonly pathFor: () => string;
  private readonly serverPgid: () => Promise<number | null>;
  private readonly groupAlive: (pgid: number) => boolean;
  private readonly signalGroup: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pidLstart: (pid: number) => string | undefined;
  private loadedPath: string | null = null;
  private readonly groups = new Map<string, AgentProcessGroup>();

  constructor(deps: AgentProcessGroupRegistryDeps = {}) {
    this.pathFor = deps.path ?? registryPath;
    this.serverPgid = deps.serverPgid ?? readServerPgid;
    this.groupAlive = deps.groupAlive ?? processGroupAlive;
    this.signalGroup = deps.signalGroup ?? groupSignal;
    this.wait = deps.wait ?? delay;
    this.now = deps.now ?? Date.now;
    this.pidLstart = deps.pidLstart ?? readPidLstart;
  }

  register(input: Omit<AgentProcessGroup, "id" | "pidLstart" | "startedAt"> & { id?: string; pidLstart?: string; startedAt?: string }): AgentProcessGroup {
    this.load();
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0 || input.pgid !== input.pid || !input.sessionKey) {
      throw new Error("agent process groups require a detached leader, its pgid, and an owning session");
    }
    const entry: AgentProcessGroup = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      pidLstart: input.pidLstart ?? this.pidLstart(input.pid),
      startedAt: input.startedAt ?? new Date(this.now()).toISOString(),
    };
    this.groups.set(entry.id, entry);
    this.save();
    return entry;
  }

  list(): AgentProcessGroup[] {
    this.load();
    return [...this.groups.values()];
  }

  async pruneIfGone(id: string): Promise<boolean> {
    this.load();
    const entry = this.groups.get(id);
    if (!entry || this.groupAlive(entry.pgid)) return false;
    this.groups.delete(id);
    this.save();
    return true;
  }

  async stopById(id: string, graceMs = 10_000): Promise<boolean> {
    this.load();
    const entry = this.groups.get(id);
    return entry ? this.stop(entry, graceMs) : false;
  }

  async stopForSession(sessionKey: string, graceMs = 10_000): Promise<number> {
    this.load();
    return this.stopMatching((entry) => !entry.preserveOnOwnerClose && entry.sessionKey === sessionKey, graceMs);
  }

  async stopForTopic(topicId: string, graceMs = 10_000): Promise<number> {
    this.load();
    return this.stopMatching((entry) => !entry.preserveOnOwnerClose && entry.topicId === topicId, graceMs);
  }

  async reconcile(isSessionAlive: (sessionKey: string) => boolean, graceMs = 10_000): Promise<number> {
    this.load();
    return this.stopMatching((entry) => !entry.preserveOnOwnerClose && !isSessionAlive(entry.sessionKey), graceMs);
  }

  private async stopMatching(matches: (entry: AgentProcessGroup) => boolean, graceMs: number): Promise<number> {
    const entries = [...this.groups.values()].filter(matches);
    const results = await Promise.all(entries.map((entry) => this.stop(entry, graceMs)));
    return results.filter(Boolean).length;
  }

  private async stop(entry: AgentProcessGroup, graceMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(entry.pgid) || entry.pgid <= 0 || entry.pgid !== entry.pid) return false;
    if (!entry.pidLstart) return false;
    const serverPgid = await this.serverPgid();
    if (!serverPgid || entry.pgid === serverPgid) return false;

    const currentLeaderStart = this.pidLstart(entry.pid);
    if (currentLeaderStart && entry.pidLstart && currentLeaderStart !== entry.pidLstart) return false;
    if (!this.groupAlive(entry.pgid)) {
      this.groups.delete(entry.id);
      this.save();
      return true;
    }

    try {
      this.signalGroup(entry.pgid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        this.groups.delete(entry.id);
        this.save();
        return true;
      }
      return false;
    }

    const deadline = this.now() + Math.max(0, graceMs);
    while (this.groupAlive(entry.pgid) && this.now() < deadline) {
      await this.wait(Math.min(100, deadline - this.now()));
    }

    if (this.groupAlive(entry.pgid)) {
      const currentServerPgid = await this.serverPgid();
      if (!currentServerPgid || entry.pgid === currentServerPgid) return false;
      try {
        this.signalGroup(entry.pgid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
    }

    this.groups.delete(entry.id);
    this.save();
    return true;
  }

  private load(): void {
    const path = this.pathFor();
    if (path === this.loadedPath) return;
    this.loadedPath = path;
    this.groups.clear();
    const data = readJsonStateFile(path, "agent-process-groups") as { groups?: unknown } | null;
    if (!Array.isArray(data?.groups)) return;
    for (const row of data.groups) {
      if (!row || typeof row !== "object") continue;
      const entry = row as AgentProcessGroup;
      if (!entry.id || !entry.sessionKey || !Number.isSafeInteger(entry.pid) || !Number.isSafeInteger(entry.pgid)) continue;
      this.groups.set(entry.id, entry);
    }
  }

  private save(): void {
    const path = this.pathFor();
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, JSON.stringify({ groups: [...this.groups.values()] }), { mode: 0o600 });
  }
}

export const agentProcessGroups = new AgentProcessGroupRegistry();

export function registerAgentProcessGroup(entry: Omit<AgentProcessGroup, "id" | "pidLstart" | "startedAt"> & { id?: string; pidLstart?: string; startedAt?: string }): AgentProcessGroup {
  return agentProcessGroups.register(entry);
}

export function stopAgentProcessGroupsForSession(sessionKey: string): Promise<number> {
  return agentProcessGroups.stopForSession(sessionKey);
}

export function reconcileAgentProcessGroups(isSessionAlive: (sessionKey: string) => boolean): Promise<number> {
  return agentProcessGroups.reconcile(isSessionAlive);
}
