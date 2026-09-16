/**
 * WHO IS HOLDING THE MEMORY, when it is not Topics.
 *
 * WHY. On 16/09/2026 seven cards sat held for hours behind the same chip -
 * «Memoria quasi finita: la lettura più bassa degli ultimi 2 minuti è 4.1 GB, // allow-italian: the chip's own text, quoted
 * sotto il pavimento di 6 GB» - and nothing anywhere said WHO had taken the // allow-italian: the chip's own text, quoted
 * memory. It was not Topics: the Claude app held about 8 GB across three
 * windows, Dia 2.6 GB, and a `next-server` left running for fourteen hours
 * 2.9 GB. The owner asked twice to "watch the load" with no way to act, which
 * is a stuck queue with no exit: the floor is a measurement, and a measurement
 * that does not name the thing you would quit is not actionable.
 *
 * COST. One `/bin/ps` on the beat that already exists (once a minute, idle
 * included), never one per card. Everything below is pure code over the lines
 * that read returns, and the grouping is what the test drives.
 *
 * RSS AND NOT FOOTPRINT, said out loud: helper processes of one app share
 * pages, so a family total is an upper bound, not a sum of disjoint memory. It
 * ranks the apps right, which is the whole job here - it gates nothing.
 */

/** One `/bin/ps -Ao pid=,ppid=,rss=,command=` line. */
export interface PsMemRow {
  pid: number;
  ppid: number;
  /** `ps` prints resident size in KB. */
  rssKB: number;
  command: string;
}

/** A family of processes and what it holds, in GB. */
export interface MemoryFamily {
  /** The APP's name, never the raw process name: "Claude", not "Claude Helper (Renderer)". */
  name: string;
  gb: number;
  procs: number;
}

/**
 * Under this a family is not worth a sentence: nobody quits an app to get
 * 400 MB back on a machine whose floor is 6 GB, and three such lines would
 * push the two that matter off the end.
 */
export const OWNER_FLOOR_GB = 0.5;
/** Two or three entries, said the brief: past the third the sentence stops being read. */
export const OWNER_TOP_N = 3;

/** Interpreters that are never the answer: `node` holds nothing, the script it runs does. */
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "ruby", "perl", "php", "java", "electron"]);

/**
 * The name of the APP a command belongs to.
 *
 * The OUTERMOST bundle wins, and that is the whole point: macOS nests the
 * helpers of an Electron app inside their own `.app`
 * (`/Applications/Claude.app/Contents/Frameworks/Claude Helper
 * (Renderer).app/Contents/MacOS/Claude Helper (Renderer)`), so the innermost
 * match would give back exactly the raw process name the brief rules out - and
 * would scatter one app over three or four lines.
 */
export function appFamilyName(command: string): string {
  const bundle = command.match(/\/([^/]+)\.app\//);
  if (bundle) return bundle[1]!;
  // An XPC service nobody claimed: its bundle is reverse-DNS, and the last
  // segment is the only readable part of it ("WebContent").
  const xpc = command.match(/\/([^/]+)\.xpc\//);
  if (xpc) return xpc[1]!.split(".").pop() || xpc[1]!;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const argv0 = base(tokens[0] ?? "");
  if (!INTERPRETERS.has(argv0)) return argv0 || "?";
  // `node /…/next/dist/bin/next dev` is "next", not "node": the first argument
  // that is a path is the program a person would recognise and stop.
  const script = tokens.slice(1).find((t) => t.includes("/") && !t.startsWith("-"));
  return script ? base(script).replace(/\.(m|c)?[jt]s$/, "") : argv0;
}

function base(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

/** The rows of `ps`, skipping whatever does not parse (a header, a torn line). */
export function parsePsMemRows(text: string): PsMemRow[] {
  const out: PsMemRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/);
    if (!m) continue;
    out.push({ pid: +m[1]!, ppid: +m[2]!, rssKB: +m[3]!, command: m[4]!.trimEnd() });
  }
  return out;
}

export interface MemoryOwnersInput {
  rows: readonly PsMemRow[];
  /** The server's own pid: its whole subtree is ours (agent CLIs, MCP servers, check runs). */
  selfPid: number;
  /** Absolute paths that mark a process as ours wherever it was reparented to (the repo, the worktrees, the app bundle). */
  ourMarkers: readonly string[];
  /**
   * `responsibility_get_pid_responsible_for_pid`: the app that ASKED for an XPC
   * service. Without it the WKWebView processes of our own browser panes read
   * as a foreign "WebContent" family - measured on this Mac, three of them, all
   * responsible to `Topics.app` - and the sentence would blame the owner for
   * memory Topics itself is holding.
   */
  ownerOf?: (pid: number) => number | null;
  top?: number;
  floorGB?: number;
}

/**
 * The heaviest families that are NOT Topics, heaviest first.
 *
 * "Not Topics" is settled in this order: the server's subtree, anything whose
 * command carries one of our paths and ITS subtree, and anything an XPC service
 * is responsible to. What is left is somebody else's.
 */
export function memoryOwners(input: MemoryOwnersInput): MemoryFamily[] {
  const { rows, selfPid, ourMarkers } = input;
  const floorGB = input.floorGB ?? OWNER_FLOOR_GB;
  const top = input.top ?? OWNER_TOP_N;
  const byPid = new Map(rows.map((r) => [r.pid, r]));

  const ours = new Set<number>();
  for (const r of rows) {
    if (r.pid === selfPid || ourMarkers.some((mark) => mark && r.command.includes(mark))) ours.add(r.pid);
  }
  // Descendants of a seed are ours too, and the table is unordered: repeat
  // until nothing new is added instead of assuming parents come first.
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) {
      if (!ours.has(r.pid) && ours.has(r.ppid)) { ours.add(r.pid); grew = true; }
    }
  }

  const totals = new Map<string, MemoryFamily>();
  for (const r of rows) {
    if (ours.has(r.pid)) continue;
    // Count the row under whoever asked for it, when that is somebody else.
    const ownerPid = input.ownerOf?.(r.pid) ?? null;
    const owner = ownerPid != null && ownerPid !== r.pid ? byPid.get(ownerPid) : undefined;
    if (owner && ours.has(owner.pid)) continue;
    const name = appFamilyName((owner ?? r).command);
    const seen = totals.get(name) ?? { name, gb: 0, procs: 0 };
    seen.gb += r.rssKB / 1e6;
    seen.procs += 1;
    totals.set(name, seen);
  }
  return [...totals.values()]
    .filter((f) => f.gb >= floorGB)
    .sort((a, b) => b.gb - a.gb || a.name.localeCompare(b.name))
    .slice(0, top);
}

/**
 * The one Italian sentence, used by the floor's message and by nothing else
 * that words it differently: a second copy is how the card and the log end up
 * saying two things about one measurement.
 */
export function formatMemoryOwners(families: readonly MemoryFamily[]): string | null {
  if (families.length === 0) return null;
  const parts = families.map((f) => `${f.name} ${f.gb.toFixed(1)} GB`);
  return `Fuori da Topics la memoria la tengono: ${parts.join(", ")}.`;
}

/** The same fact for the `[memsig]` line: one field, no spaces, `-` when there is nothing. */
export function memoryOwnersLogField(families: readonly MemoryFamily[]): string {
  if (families.length === 0) return "-";
  return families.map((f) => `${f.name.replace(/\s+/g, "_")}:${f.gb.toFixed(1)}`).join(",");
}
