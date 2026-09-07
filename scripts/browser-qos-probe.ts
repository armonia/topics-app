/**
 * THE PROOF THAT THE BAND ACTUALLY MOVES (card 7f4d8f32).
 *
 * Run: `bun run scripts/browser-qos-probe.ts`
 *
 * Builds a BrowserService wired exactly like the server's - an owner resolver
 * and the agent/person criterion - opens ONE context that belongs to an agent,
 * and prints the process table of the whole Chromium tree. Then the same
 * context gains a watcher (a person opening a browser pane on it), the
 * governor is asked again, and the table is printed a second time.
 *
 * What to read: the `PRI` column. On macOS a process in the background QoS
 * band drops to PRI 4 whatever its nice value; out of it, it is back at 20.
 * `launchctl procinfo` says the same thing but needs root, and this does not.
 *
 * It never touches the running server: its own CDP port, no orphan sweep, and
 * the context is destroyed at the end.
 */
import { createBrowserService } from "../server/browser-service";

const AGENT_CONTEXT = "qos-probe";
const owners = new Map<string, { sessionKey?: string; workspace?: string; watchers: number }>();

function processTable(): string {
  const mark = `topics-browser=agent:${process.pid}`;  // no leading dashes: pgrep would read them as options
  const pids = Bun.spawnSync(["/usr/bin/pgrep", "-f", mark]).stdout.toString()
    .split("\n").map((l) => Number(l.trim())).filter((n) => n > 0 && n !== process.pid);
  if (!pids.length) return "(no marked Chromium found)";
  const all = new Set<number>(pids);
  for (const pid of pids) {
    const kids = Bun.spawnSync(["/usr/bin/pgrep", "-P", String(pid)]).stdout.toString()
      .split("\n").map((l) => Number(l.trim())).filter((n) => n > 0);
    for (const k of kids) all.add(k);
  }
  const args = ["/bin/ps", "-o", "pid=,ppid=,ni=,pri=,comm="];
  for (const pid of all) args.push("-p", String(pid));
  const rows = Bun.spawnSync(args).stdout.toString().trimEnd().split("\n").filter(Boolean).map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(.*)$/);
    if (!m) return line;
    // The executable's last path component only: the full path of a Chromium
    // helper is 200 characters of noise around the column that matters.
    const name = m[5]!.slice(m[5]!.lastIndexOf("/") + 1);
    return `${m[1]!.padStart(6)} ${m[2]!.padStart(6)} ${m[3]!.padStart(3)} ${m[4]!.padStart(4)}  ${name}`;
  });
  return ["   PID   PPID  NI  PRI  PROCESS", ...rows].join("\n");
}

const service = await createBrowserService({
  cdpPort: 19555,  // not the server's 19222: this probe must not adopt its browser
  resolveContextOwner: (id) => owners.get(id) ?? {},
  agentOwnerTest: {
    isDispatched: (sessionKey) => sessionKey.startsWith("card:"),
    isAgentCwd: () => false,
  },
  broadcastToBrowserWs: () => {},
});

owners.set(AGENT_CONTEXT, { sessionKey: "card:qos-probe", watchers: 0 });
await service.getOrCreate(AGENT_CONTEXT);
await Bun.sleep(500);
console.log(`\n== ${new Date().toLocaleTimeString()} - one agent context, nobody watching ==`);
console.log(processTable());

owners.set(AGENT_CONTEXT, { sessionKey: "card:qos-probe", watchers: 1 });
service.refreshBackgroundPriority("a person opened a browser pane");
await Bun.sleep(500);
console.log(`\n== ${new Date().toLocaleTimeString()} - a person is watching that same context ==`);
console.log(processTable());

owners.set(AGENT_CONTEXT, { sessionKey: "card:qos-probe", watchers: 0 });
service.refreshBackgroundPriority("the person closed the pane");
await Bun.sleep(500);
console.log(`\n== ${new Date().toLocaleTimeString()} - the person left, agents only again ==`);
console.log(processTable());

await service.destroyContext(AGENT_CONTEXT).catch(() => {});
await service.close();
process.exit(0);
