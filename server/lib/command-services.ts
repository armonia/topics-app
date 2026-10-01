/**
 * A COMMAND THAT SERVES A PORT IS A SERVER, NOT WORK THE CHAT WAITS FOR (BGVIS-08).
 *
 * On 01/10 an agent started `python3 -m http.server 8777` with `run_command`
 * and `wake: false`, and the chat said "waiting for 1 background job" for as
 * long as the server ran, with the grey ring on its sidebar row and tab. A
 * server is not waited on: nothing will come back from it, and the chat is
 * free. Claude Code and the IDEs show a running server as a server, with its
 * address and a way to open it.
 *
 * WHAT MAKES ONE, measured and not guessed from the command line: a command
 * that does NOT wake the chat (`wake: false`, the parameter the tool tells the
 * agent to use for "things that are not meant to end, such as a dev server")
 * AND whose process tree holds at least one listening TCP port. A command that
 * wakes the chat stays work the chat waits for, port or not: its end is news
 * the agent asked for. One that listens on nothing stays one too.
 *
 * THE PORTS ARE WATCHED, NOT ASKED AT EVERY READ. The status route is polled by
 * every window every 15 s and must not spawn `lsof`; a server binds its port a
 * moment after it starts, so a probe at start would see nothing. A timer runs
 * only while such a command runs: every 2 s at first, doubling to 30 s while
 * nothing changes, back to 2 s at every start. Each change (a port that
 * appears, one that goes) is pushed (`onChange`), as a start and an end are.
 *
 * The last addresses of a server are kept for a few seconds after it ends, so
 * the chat can say that the server ended and how (`SERVICE_END_SHOWN_MS`); a
 * pass that finds no port on a server that is going (stopped, or its process
 * dead and its row not closed yet) keeps them too.
 */
import type { ListenAddress, RunningServiceSummary, TopicServices } from "../../shared/background-work";

/** The part of a registry row this reads. */
export interface ServiceRowLike {
  processId: string;
  scriptName: string;
  command: string;
  startedAt: string;
  status: string;
  pid?: number | null;
  completedAt?: string;
  exitCode?: number;
  cmd?: { sessionKey: string; topicId: string | null; wake: boolean; stopped?: boolean };
}

/** How long an ended server keeps its row in the status answer, saying how it ended. */
export const SERVICE_END_SHOWN_MS = 8_000;
export const SERVICE_WATCH_MIN_MS = 2_000;
export const SERVICE_WATCH_MAX_MS = 30_000;

/** Is this running row a server: no wake, and listening? */
export function isServiceRow(row: { cmd?: { wake: boolean } }, listen: ReadonlyArray<ListenAddress> | undefined): boolean {
  return !!row.cmd && !row.cmd.wake && !!listen && listen.length > 0;
}

/** Only a command that does not wake its chat can be a server: the only rows worth an `lsof`. */
export function isServiceCandidate(row: ServiceRowLike): boolean {
  return !!row.cmd && !row.cmd.wake && row.status === "running" && !!row.pid;
}

function sameListen(a: ReadonlyArray<ListenAddress> | undefined, b: ReadonlyArray<ListenAddress>): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((x, i) => x.host === b[i]!.host && x.port === b[i]!.port);
}

/** The first line of a command, cut: what the row names when the agent gave no description. */
export function commandShort(command: string): string {
  const first = (command.split("\n").find((l) => l.trim()) ?? command).replace(/\s+/g, " ").trim();
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

/**
 * The servers of every chat, for `GET /api/topics/streaming`: the running ones
 * and, for `SERVICE_END_SHOWN_MS`, the ones that ended, with how. A command
 * with no topic (a terminal's session) has no chat to show it in.
 */
export function servicesOver(
  running: Iterable<ServiceRowLike>,
  recent: Iterable<ServiceRowLike>,
  listenOf: (processId: string) => ReadonlyArray<ListenAddress> | undefined,
  now: number,
): TopicServices[] {
  const byTopic = new Map<string, TopicServices>();
  const add = (row: ServiceRowLike, service: RunningServiceSummary) => {
    const cmd = row.cmd!;
    if (!cmd.topicId) return;
    let entry = byTopic.get(cmd.topicId);
    if (!entry) { entry = { topicId: cmd.topicId, sessionKey: cmd.sessionKey, services: [] }; byTopic.set(cmd.topicId, entry); }
    entry.services.push(service);
  };
  const summary = (row: ServiceRowLike, listen: ReadonlyArray<ListenAddress>): RunningServiceSummary => {
    const startedAt = Date.parse(row.startedAt);
    return {
      processId: row.processId, description: row.scriptName, command: commandShort(row.command), listen: [...listen],
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    };
  };
  for (const row of running) {
    const listen = listenOf(row.processId);
    if (row.status === "running" && isServiceRow(row, listen)) add(row, summary(row, listen!));
  }
  for (const row of recent) {
    const listen = listenOf(row.processId);
    if (!row.cmd || row.status === "running" || !listen?.length) continue;
    const at = row.completedAt ? Date.parse(row.completedAt) : NaN;
    if (!Number.isFinite(at) || now - at > SERVICE_END_SHOWN_MS) continue;
    const stopped = !!row.cmd.stopped;
    add(row, { ...summary(row, listen), ended: { at, exitCode: stopped ? null : row.exitCode ?? null, stopped } });
  }
  for (const entry of byTopic.values()) entry.services.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return [...byTopic.values()];
}

export interface ServiceWatch {
  /** The listening addresses last seen for a command (kept a while after it ends). */
  listenOf: (processId: string) => ReadonlyArray<ListenAddress> | undefined;
  /** A command started or was re-adopted: watch at the fast cadence again. */
  kick: () => void;
  /** One pass now; true when an address changed. Exported for the tests, the timer calls it. */
  tick: () => Promise<boolean>;
  /** Drop what is kept for an ended command. */
  forget: (processId: string) => void;
}

/**
 * The watcher over the registry's running rows. `listenersOf` maps tracked pids
 * to the addresses their process trees listen on (one `lsof`, shared).
 */
export function serviceWatch(deps: {
  rows: () => Iterable<ServiceRowLike>;
  listenersOf: (pids: number[]) => Promise<Map<number, ListenAddress[]>>;
  /** Is this pid still a live process (a zombie is not). */
  alive: (pid: number) => boolean;
  onChange: (row: ServiceRowLike) => void;
}): ServiceWatch {
  const listen = new Map<string, ListenAddress[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = SERVICE_WATCH_MIN_MS;
  let running = false;
  let kicked = false;

  async function tick(): Promise<boolean> {
    const candidates = [...deps.rows()].filter(isServiceCandidate);
    if (candidates.length === 0) return false;
    let byPid: Map<number, ListenAddress[]>;
    try { byPid = await deps.listenersOf(candidates.map((r) => r.pid!)); } catch { return false; /* a failed probe says nothing */ }
    let changed = false;
    for (const row of candidates) {
      // A row that ended during the probe keeps the addresses it last had.
      if (row.status !== "running") continue;
      const next = (byPid.get(row.pid!) ?? []).slice().sort((a, b) => a.port - b.port || a.host.localeCompare(b.host));
      const prev = listen.get(row.processId);
      if (next.length === 0 && !prev) continue;
      // No port because the server is going (stopped, or its process gone and
      // its row not yet closed: a re-adopted one is closed by a pid check every
      // few seconds). It stays a server until its row closes, so the chat says
      // how it ended instead of turning it into a task it waits for.
      if (next.length === 0 && (row.cmd!.stopped || !deps.alive(row.pid!))) continue;
      if (sameListen(prev, next)) continue;
      if (next.length) listen.set(row.processId, next); else listen.delete(row.processId);
      changed = true;
      deps.onChange(row);
    }
    return changed;
  }

  function arm(): void {
    if (timer || running) return;
    timer = setTimeout(async () => {
      timer = null;
      running = true;
      let changed = false;
      kicked = false;
      try { changed = await tick(); } finally { running = false; }
      // Nothing to watch any more: the timer stops until the next start.
      if (![...deps.rows()].some(isServiceCandidate)) { delay = SERVICE_WATCH_MIN_MS; return; }
      delay = changed || kicked ? SERVICE_WATCH_MIN_MS : Math.min(delay * 2, SERVICE_WATCH_MAX_MS);
      arm();
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
  }

  return {
    listenOf: (id) => listen.get(id),
    kick() {
      delay = SERVICE_WATCH_MIN_MS;
      kicked = true; // a pass in flight re-arms at the fast cadence
      if (timer) { clearTimeout(timer); timer = null; }
      arm();
    },
    tick,
    forget: (id) => { listen.delete(id); },
  };
}

/**
 * A chat's `run_command` processes, running and recent, with the ports they
 * listen on: the first rows of `GET /api/processes`. That route listed only the
 * provider's sub-agent sessions, so a server the chat showed answered `[]`.
 */
export function commandProcessesOf(
  rows: Iterable<ServiceRowLike>,
  topicId: string,
  listenOf: (processId: string) => ReadonlyArray<ListenAddress> | undefined,
) {
  return [...rows].filter((r) => r.cmd?.topicId === topicId).map((r) => ({
    kind: "command" as const,
    processId: r.processId,
    sessionKey: r.cmd!.sessionKey,
    label: r.scriptName,
    status: r.status === "running" ? "running" as const : "done" as const,
    startedAt: r.startedAt,
    ...(r.status !== "running" && r.completedAt ? { completedAt: r.completedAt } : {}),
    ports: (listenOf(r.processId) ?? []).map((a) => a.port),
  }));
}
