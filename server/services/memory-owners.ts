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
 * FOOTPRINT AND NOT RSS, and the difference is not small: measured on this Mac
 * on 16/09/2026 the Claude family reads 7.01 GB of resident size across 33
 * processes and 10.88 GB of `phys_footprint`, 55% more. Activity Monitor shows
 * the footprint, so a card saying 7.0 GB would be naming a number the owner
 * cannot find anywhere on his screen - and `rss` reads SMALL exactly while a
 * tree thrashes, which is the only moment this sentence is ever printed (the
 * same reason `swap-freeze.ts` picks its victim on footprint). `procFootprintKB`
 * is the FFI the fleet already calls, no extra fork; `rssKB` stays the fallback
 * for a pid the kernel will not answer for.
 *
 * A family total is still an upper bound and not a sum of disjoint memory -
 * helpers of one app share pages either way. It ranks the apps right, which is
 * the whole job here: it gates nothing.
 */

/** One `/bin/ps -Ao pid=,ppid=,rss=,command=` line. */
export interface PsMemRow {
  pid: number;
  ppid: number;
  /** `ps` prints resident size in KB. */
  rssKB: number;
  /** `phys_footprint` in KB, when the kernel answered for this pid: what a family is summed on. */
  footprintKB?: number;
  command: string;
}

/** What the row weighs: the footprint when there is one, resident size when there is not. */
export function rowGB(r: PsMemRow): number {
  return (r.footprintKB ?? r.rssKB) / 1e6;
}

/** A family of processes and what it holds, in GB. */
export interface MemoryFamily {
  /** The APP's name, never the raw process name: "Claude", not "Claude Helper (Renderer)". */
  name: string;
  gb: number;
  procs: number;
}

/**
 * THE BUNDLES THAT ARE OURS wherever a process was reparented to.
 *
 * `Topics Host.app` is not a second name for `Topics.app`. It is the program of
 * the `com.armonia.topics-server` LaunchAgent, built from this repo
 * (`scripts/build-topics-host.sh`), and it is the parent of `start-prod.sh` and
 * so the server's own ANCESTOR - while the descent below only walks DOWN from
 * the server, never up. Left out it is a FOREIGN family named after us, and
 * every XPC service macOS makes it responsible for goes in with it: measured
 * 16/09/2026, pid 808 is the responsible app of 28 processes that are not ours
 * at all.
 */
export const OUR_APP_MARKERS: readonly string[] = ["/Topics.app/", "/Topics Host.app/"];

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
  if (!script) return argv0;
  const file = base(script).replace(/\.(m|c)?[jt]s$/, "");
  if (!GENERIC_ENTRY.has(file)) return file;
  // ...unless the file is the entry point every package has: nobody recognises
  // `index`. `/opt/homebrew/lib/node_modules/openclaw/dist/index.js gateway` is
  // the OpenClaw gateway, and it read as a family called `index` - the heaviest
  // non-app node process on this Mac named after a file name.
  const parts = script.split("/").slice(0, -1).filter(Boolean);
  for (let k = parts.length - 1; k >= 0; k--) {
    const dir = parts[k]!;
    if (!BUILD_DIRS.has(dir)) return dir;
  }
  return file;
}

/** File names that name nothing: every package has one. */
const GENERIC_ENTRY = new Set(["index", "main", "cli"]);
/** Directories that hold build output, not a program: skipped when climbing out of a generic entry point. */
const BUILD_DIRS = new Set(["dist", "build", "lib", "bin", ".bin", "src", "out", "esm", "cjs", "node_modules"]);

/** An XPC service, the only row whose name may come from somebody else. */
function isXpc(command: string): boolean {
  return command.includes(".xpc/");
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
   *
   * ASKED ONLY OF AN XPC SERVICE, which is what it is for. It answers for 600
   * pids of 901 on this machine, and asking it about every row handed the NAME
   * of somebody else's process to whoever had launched it: `next-server` (pid
   * 24276) is responsible to the OpenClaw gateway and was counted in a family
   * called `index`, after the bundle's `dist/index.js` - the process the
   * sentence exists to name came out named after a file. That one lookup built
   * families of `index` (24 processes, 0.94 GB), `npm` and `mcp-remote` out of
   * unrelated programs.
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

  const totals = new Map<string, MemoryFamily & { installed: boolean; bundle: boolean }>();
  for (const r of rows) {
    if (ours.has(r.pid)) continue;
    // An XPC service is counted under whoever ASKED for it - and only an XPC
    // service: see `ownerOf`. Everything else is named by its own command line.
    const ownerPid = isXpc(r.command) ? input.ownerOf?.(r.pid) ?? null : null;
    const owner = ownerPid != null && ownerPid !== r.pid ? byPid.get(ownerPid) : undefined;
    if (owner && ours.has(owner.pid)) continue;
    const from = (owner ?? r).command;
    const name = appFamilyName(from);
    const seen = totals.get(name) ?? { name, gb: 0, procs: 0, installed: false, bundle: false };
    seen.gb += rowGB(r);
    seen.procs += 1;
    // INSTALLED, not merely bundled: the app the owner would quit lives under an
    // Applications root (/Applications, /System/Applications, ~/Applications) at
    // ANY depth below it - /System/Applications/Utilities/Terminal.app and
    // /Applications/UniversalKeychain/UniversalKeychain.app are both installed.
    // A command a program ships runs from inside its own `.app` elsewhere:
    // measured 16/09, the CLI at `…/Application Support/Claude/claude-code/
    // 2.1.270/claude.app/Contents/MacOS/claude` is in a bundle too, so a test on
    // "is it in a .app" left `Claude` and `claude` side by side, which is the one
    // thing this rule exists to prevent. The user root takes exactly one segment
    // for the account name, so somebody's own `Projects/Applications/Foo.app` is
    // not mistaken for an installed app.
    seen.installed ||= /^\/(?:System\/)?Applications\//.test(from) || /^\/Users\/[^/]+\/Applications\//.test(from);
    seen.bundle ||= /\/[^/]+\.app\//.test(from);
    totals.set(name, seen);
  }
  // TWO LINES THAT DIFFER ONLY BY CASE are two lines nobody can tell apart.
  // Measured 16/09: `Claude 7.0 GB` (the app) beside `claude 1.1 GB` (the CLI
  // the app ships). The INSTALLED app keeps the bare name; the command says
  // what it is, wherever it runs from.
  // Among the families that share a word, ONE keeps it bare: the installed app
  // first, then whatever at least runs from a bundle, then the plain binary.
  // Without the ranking two families neither of which is installed (a `.app`
  // somebody keeps in a project folder, and a binary of the same name) would
  // both be qualified, and the sentence would be back to two lines that differ
  // only by case.
  const rank = (f: { installed: boolean; bundle: boolean }): number => (f.installed ? 2 : f.bundle ? 1 : 0);
  const best = new Map<string, number>();
  for (const f of totals.values()) {
    const key = f.name.toLowerCase();
    best.set(key, Math.max(best.get(key) ?? -1, rank(f)));
  }
  const bareTaken = new Set<string>();
  for (const f of totals.values()) {
    const key = f.name.toLowerCase();
    const alone = [...totals.values()].filter((o) => o.name.toLowerCase() === key).length < 2;
    if (alone) continue;
    if (rank(f) === best.get(key) && !bareTaken.has(key)) { bareTaken.add(key); continue; }
    f.name = `${f.name} (comando)`; // allow-italian: the owner reads this name inside an Italian sentence
  }
  return [...totals.values()]
    .map(({ name, gb, procs }) => ({ name, gb, procs }))
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
