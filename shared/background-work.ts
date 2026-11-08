/**
 * What a chat is still waiting on, turn open or not: the work its last turn
 * left running (an Agent, a Bash, a Monitor, a Workflow) or a session cron it
 * armed (`type: "cron"`, named by its schedule), as the `background`
 * row of `GET /api/topics/streaming` carries it. One declaration for the server
 * that writes it and the client that draws it.
 */

/**
 * One task, named: `description` falls back on `type` when the CLI gave none.
 * `type` is the CLI's (`local_bash`, `local_agent`), `cron`, `monitor` for a
 * Monitor, which the CLI lists as a `local_bash`, or `command` for a process
 * the agent started with the Topics tool `run_command`, which lives in Topics'
 * own process registry and not in the CLI. `startedAt` (epoch ms) is when the
 * server first saw it running (a command's own start); a server older than the
 * field sends none. Only a command carries `processId` (the row of the
 * Processes panel that opens it) and `wakes` (its end wakes the chat).
 */
export type BackgroundTaskSummary = { type: string; description: string; startedAt?: number; processId?: string; wakes?: boolean };

/**
 * `tasks` is empty when a task has reported and the CLI is about to wake to
 * answer it. `lastSignalAt` is when the CLI last printed something about the
 * work (epoch ms).
 */
export type BackgroundWorkDetail = { tasks: BackgroundTaskSummary[]; lastSignalAt: number };

/**
 * A listening TCP address of a command's process tree, as `lsof` reports it:
 * `host` is `127.0.0.1`, `[::1]`, or `*` for every interface.
 */
export type ListenAddress = { host: string; port: number };

/**
 * A `run_command` that serves a port and does not wake its chat: a server, not
 * work the chat waits for (BGVIS-08). `description` is the registry's name of
 * the process, `command` its first line, cut. `ended` is there for a few
 * seconds after it exits: when, its exit code (null = none recorded) and
 * whether a Stop ended it. `listen` has one address per port, and the first is
 * the one the row opens (the page, when the command serves more than one port).
 */
export type RunningServiceSummary = {
  processId: string;
  description: string;
  command: string;
  listen: ListenAddress[];
  startedAt?: number;
  ended?: { at: number; exitCode: number | null; stopped: boolean };
};

/** The servers of one chat, as `GET /api/topics/streaming` carries them in `services`. */
export type TopicServices = { topicId: string; sessionKey: string; services: RunningServiceSummary[] };

/** Every interface: the address to open is the loopback. */
const ANY_HOST = new Set(["*", "0.0.0.0", "[::]", "::"]);

/** How the row writes an address: `127.0.0.1:8777`, `0.0.0.0:3000` for every interface. */
export function listenLabel(a: ListenAddress): string {
  return `${a.host === "*" ? "0.0.0.0" : a.host}:${a.port}`;
}

/**
 * Whether other devices can open a server listening on `a`: every interface,
 * or an address that is not the loopback (a LAN or VPN address). On 24/10 the
 * finance chat's server listened on 0.0.0.0:8777 and nothing said so.
 * A link-local address (fe80::/10) counts as local: lsof on macOS writes the
 * loopback's own fe80::1%lo0 as `[fe80:1::1]`, and nobody opens a dev server
 * from another device by its link-local address.
 */
export function reachableFromNetwork(a: ListenAddress): boolean {
  const host = a.host.replace(/^\[|\]$/g, "");
  return !(host === "::1" || host === "localhost" || /^(::ffff:)?127\./.test(host) || /^fe[89ab][0-9a-f]:/i.test(host));
}

/**
 * The rule every way of starting a server gives the agent: `run_command`,
 * `run_script`, and the CLI's own background shell through the system prompt.
 * It is only a sentence, an agent can still bind 0.0.0.0: the LAN badge
 * (`reachableFromNetwork`) is what catches it, where the ports can be read.
 */
export const BIND_LOOPBACK_NOTE =
  "Bind a server to 127.0.0.1, not 0.0.0.0, unless the person wants other devices to reach it: `--host 127.0.0.1`, and through npm `npm run dev -- --host 127.0.0.1` (without the `--` npm keeps the flag).";

/**
 * `run_script` passes no flags, so a declared script that opens its server to
 * every interface (`"dev": "vite --host"`) cannot follow the rule through it:
 * it is started the other way, by command. `how` names that way where it
 * exists (`run_command` is not offered on Windows).
 */
export function runScriptBindNote(how: string): string {
  return `run_script passes no flags: when a script's server listens on every interface (\`vite --host\`), start it ${how} instead, as \`npm run <script> -- --host 127.0.0.1\`.`;
}

/** The URL that opens a server listening on `a`: plain http on the loopback when it listens everywhere. */
export function listenUrl(a: ListenAddress): string {
  return `http://${ANY_HOST.has(a.host) ? "127.0.0.1" : a.host}:${a.port}/`;
}
