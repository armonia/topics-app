/**
 * WITH THE MAC IN SUSTAINED SWAP, THE HEAVIEST COMMAND AN AGENT LAUNCHED IN THE
 * BACKGROUND STOPS TOUCHING PAGES UNTIL THERE IS ROOM AGAIN.
 *
 * Owner's answer, 15/09/2026: «freezza il piu pesante mostrando un effetto di
 * congelamento figo sulla card realistico» (allow-italian: the owner's own words, quoted).
 * This is the half that decides; the frost is the client's
 * (`components/Shared/SwapIce.tsx`).
 *
 * WHAT IS NEVER FROZEN, and none of it is prudence in general:
 *  - the server and its process group. A native `bash` tool is a child of the
 *    SERVER and shares its group (measured: 981, with `start-prod.sh` and the
 *    watch supervisor), so a group signal to the root of a native command stops
 *    Topics itself, and a stopped server is the one process that could have
 *    continued it. `allowedGroups` makes that impossible by construction and the
 *    pre-signal guard checks it again before the first signal;
 *  - the agent CLIs, their MCP servers and LSPs (a paused CLI can lose its
 *    stream, a paused MCP server hangs every tool call of the session);
 *  - a foreground Bash of Claude Code: its CLI kills it on a wall clock that
 *    keeps running while it is stopped (`background-bash-record.ts`);
 *  - a tree with a network peer outside itself: its clients would hang, not fail -
 *    and a tree whose peers could not be read AT ALL, because an `lsof` that did
 *    not answer is a measurement nobody made, not a tree with no clients;
 *  - human shell panes, and anything not under a Topics agent.
 *
 * THE ORDER WITH THE CHECK BRAKE. The brake kills the youngest heavy check round
 * and gives memory BACK; a freeze gives nothing back. So the brake goes first on
 * every beat and the two levers share one 120 s spacing: otherwise each would be
 * measuring the other's effect.
 *
 * CALM IS NOT A THAW. Calm is what a freeze produces; thawing on it restarts the
 * thrash and refreezes 120 s later. A tree is continued on ROOM, on NO EFFECT
 * (the thrash was not its), at TEN MINUTES, or when its owner is gone - and at
 * shutdown and at boot, from the ledger.
 */
import {
  FREEZES_PER_TREE,
  FREEZE_MAX_MS,
  FREEZE_MIN_CORES,
  FREEZE_MIN_GB,
  FREEZE_ROOM_FLOOR_GB,
  NO_EFFECT_FROM_MS,
  NO_EFFECT_RATIO,
  NO_EFFECT_TO_MS,
  SWAP_ACTION_SPACING_MS,
  type SwapFreezeView,
  type ThawReason,
} from "../../shared/swap-freeze";
import {
  allowedGroups,
  containsAgentCli,
  descendantPids,
  guardSet,
  toolRoots,
  type AgentSessionRef,
  type GuardRoles,
  type NativeCommandRef,
  type PsRow,
  type ToolRoot,
} from "../lib/agent-tool-children";
import { looksLikeAppExecutable } from "../lib/xpc-attribution";
import type { LedgerBatch, LedgerPidRef, SwapFreezeLedger } from "./swap-freeze-ledger";
import { signed, swapReasonIt, swapSigns, type HeldMemory, type SwapVerdict } from "./mem-signal";

/** One tree measured on a sustained beat, before anything is chosen. */
export interface FreezeCandidate {
  root: ToolRoot;
  treePids: number[];
  xpcPids: number[];
  footprintGB: number;
  residentGB: number;
  cpuCores: number;
  frozenCount: number;
}

export type VictimSkip = "belowFloor" | "exhausted" | null;

/**
 * THE HEAVIEST, measured on FOOTPRINT and not on resident memory: footprint is
 * what survives compression, and `rss` reads small exactly while a tree thrashes
 * (memory note `memoria-numeri-che-mentono`, allow-italian: the note's own filename).
 * The CPU term names one specific
 * failure: an idle 2 GB background process is the heaviest tree on the machine
 * and freezing it stops no page activity at all.
 */
export function pickVictim(candidates: readonly FreezeCandidate[]): { victim: FreezeCandidate | null; skipped: VictimSkip } {
  const heavy = candidates.filter((c) => c.footprintGB >= FREEZE_MIN_GB && c.cpuCores >= FREEZE_MIN_CORES);
  if (heavy.length === 0) return { victim: null, skipped: "belowFloor" };
  const open = heavy.filter((c) => c.frozenCount < FREEZES_PER_TREE);
  if (open.length === 0) return { victim: null, skipped: "exhausted" };
  const victim = open.reduce((a, b) => (b.footprintGB > a.footprintGB || (b.footprintGB === a.footprintGB && b.cpuCores > a.cpuCores) ? b : a));
  return { victim, skipped: null };
}

/** What a frozen tree is asked on every beat. The first answer that holds wins. */
export function thawReason(i: {
  now: number;
  frozenAt: number;
  ownerGone: boolean;
  sustained: boolean;
  heldGB: number | null;
  residentGBAtFreeze: number;
  pagesReadBackPerS: number | null;
  pagesReadBackAtFreeze: number | null;
  /** The no-effect question is asked once per freeze. */
  effectAlreadyRead: boolean;
}): ThawReason | null {
  if (i.ownerGone) return "owner gone";
  const age = i.now - i.frozenAt;
  if (!i.sustained && i.heldGB != null && i.heldGB >= FREEZE_ROOM_FLOOR_GB + i.residentGBAtFreeze) return "room";
  if (
    !i.effectAlreadyRead && age >= NO_EFFECT_FROM_MS && age < NO_EFFECT_TO_MS &&
    i.pagesReadBackPerS != null && i.pagesReadBackAtFreeze != null && i.pagesReadBackAtFreeze > 0 &&
    i.pagesReadBackPerS >= NO_EFFECT_RATIO * i.pagesReadBackAtFreeze
  ) return "no effect";
  if (age >= FREEZE_MAX_MS) return "max";
  return null;
}

/** A tree this server has stopped. */
interface FrozenTree {
  treeId: string;
  root: ToolRoot;
  rootRef: LedgerPidRef;
  batches: LedgerBatch[];
  stoppedPids: number[];
  frozenAt: number;
  n: number;
  footprintGB: number;
  residentGBAtFreeze: number;
  pagesReadBackAtFreeze: number | null;
  debtAtFreeze: number | null;
  effectAlreadyRead: boolean;
  thawing: boolean;
}

export interface SwapFreezerDeps {
  now?: () => number;
  /** One fresh `ps -axo pid=,ppid=,pgid=,time=,command= -ww`; `null` if `ps` was mute. */
  processTable: () => Promise<PsRow[] | null>;
  footprintKB: (pid: number) => number | null;
  residentKB: (pid: number) => number | null;
  /**
   * `pid -> lstart`, or `null` when `ps` did not answer at all. The difference
   * decides whether a tree may be stopped: a pid MISSING from an answer is gone,
   * a pid missing because there was no answer has an identity we simply cannot
   * read, and an identity we cannot read is not one we can undo.
   */
  lstartOf: (pids: number[]) => Promise<Map<number, string> | null>;
  statOf: (pids: number[]) => Promise<Map<number, string> | null>;
  signal: (pid: number, sig: "SIGSTOP" | "SIGCONT") => void;
  sessions: () => AgentSessionRef[];
  natives: () => NativeCommandRef[];
  guardRoles: (rows: readonly PsRow[]) => GuardRoles;
  /** Attributed WebKit-style XPC services of an `.app` inside the tree. */
  xpcServicePids: (appPid: number, appCommand: string, commandOf: (pid: number) => string | undefined) => Promise<number[]>;
  /**
   * ESTABLISHED peers of the tree whose pid is outside it: a dev server somebody
   * is watching. `null` when `lsof` did not answer - which is NOT an empty list,
   * and is read here as "this candidate cannot be cleared", never as "nobody is
   * connected to it".
   */
  outsidePeers: (pids: readonly number[]) => Promise<number[] | null>;
  ledger: SwapFreezeLedger;
  log: (line: string) => void;
  /** The card's thread, when the session works on one. */
  note?: (taskId: string, text: string) => void;
  /** Notifications and the WS frame. */
  announce?: (event: FreezeEvent) => void;
  /** Stops and re-arms a native command's own deadline, and tells the agent. */
  onFreezeTree?: (root: ToolRoot) => void;
  onThawTree?: (root: ToolRoot, frozenMs: number) => void;
}

export type FreezeEvent =
  | { kind: "frozen"; view: SwapFreezeView }
  | { kind: "thawed"; view: SwapFreezeView; reason: ThawReason; frozenMs: number };

export interface SwapFreezer {
  /** One beat. `brake` is what the check brake did on this same beat. */
  tick(i: { swap: SwapVerdict; held: HeldMemory; brake: { interrupted: boolean; skipped: string | null } }): Promise<void>;
  /** The session is being stopped or killed: continue its trees before the SIGTERM. */
  release(sessionKey: string): Promise<void>;
  thawAll(reason?: ThawReason): Promise<void>;
  views(): SwapFreezeView[];
  isHold(sessionKey: string): boolean;
  /** How much of the time since `t` this session spent frozen. */
  frozenMsSince(sessionKey: string, t: number): number;
  frozenCount(): number;
  frozenGB(): number;
  /** The last moment either swap lever acted, for the shared spacing. */
  lastActionAt(): number;
}

const gb = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? "?" : n.toFixed(1));

export function createSwapFreezer(deps: SwapFreezerDeps): SwapFreezer {
  const now = deps.now ?? Date.now;
  const frozen = new Map<string, FrozenTree>();
  /** Closed frozen intervals per session, for the silence clocks. */
  const history = new Map<string, { from: number; to: number }[]>();
  /** CPU time of each root tree on the previous sustained beat. */
  const cpuBase = new Map<number, { at: number; seconds: number }>();
  let lastFreezeAt = Number.NEGATIVE_INFINITY;
  /**
   * Roots this episode has nothing more to ask of: thawed for `no effect` (the
   * thrash was not theirs) or signalled without a single pid reading `T`.
   * Trying either again 120 s later spends the one action of a beat to learn
   * what is already known. Forgotten when the swap calms down.
   */
  const noEffectThisEpisode = new Set<number>();
  /** A beat that continued a tree does not also freeze one: one action per beat. */
  let thawedThisBeat = false;
  let disabled = false;
  let saidExhausted = false;
  let saidNothing = false;
  /**
   * Pids whose "skipped" or "unrecognised" line has already been written. The
   * beat runs every 10 s for the whole swap episode and those facts do not
   * change while the pid lives: before this the same line came out on every
   * beat (46 times for one pid, 1.669 lines out of 5 MB of the production log
   * on 23/09). Keyed by pid AND kind, so being named for one reason never
   * hides the other; pruned against the live table on every beat and emptied
   * when the episode ends, so a recycled pid or a new episode is named again.
   */
  const namedPids = new Map<number, Set<"foreground" | "unrecognised">>();
  const logOncePerPid = (pid: number, kind: "foreground" | "unrecognised", line: string): void => {
    const kinds = namedPids.get(pid) ?? new Set();
    if (kinds.has(kind)) return;
    kinds.add(kind);
    namedPids.set(pid, kinds);
    deps.log(line);
  };
  let episodeSince: number | null = null;
  let ticking = false;

  /** The roles, with the native roots named so the server-group rule spares them. */
  const guardRolesFor = (rows: readonly PsRow[]): GuardRoles => ({
    ...deps.guardRoles(rows),
    nativeRootPids: deps.natives().map((n) => n.pid),
  });

  const viewOf = (t: FrozenTree): SwapFreezeView => ({
    id: t.treeId,
    sessionKey: t.root.sessionKey,
    topicId: t.root.topicId,
    terminalId: t.root.terminalId,
    taskId: t.root.taskId,
    command: t.root.command.length > 80 ? `${t.root.command.slice(0, 79)}…` : t.root.command,
    footprintGB: t.footprintGB,
    pagesReadBackPerS: t.pagesReadBackAtFreeze,
    debtGBPerMin: t.debtAtFreeze,
    frozenAt: t.frozenAt,
    thawBy: t.frozenAt + FREEZE_MAX_MS,
    n: t.n,
  });

  function noteInterval(sessionKey: string, from: number, to: number): void {
    const list = history.get(sessionKey) ?? [];
    list.push({ from, to });
    // Two hours of history answers every clock that asks; more is a leak.
    history.set(sessionKey, list.filter((x) => to - x.to < 2 * 60 * 60_000).slice(-40));
  }

  async function thaw(tree: FrozenTree, reason: ThawReason): Promise<void> {
    if (tree.thawing) return;
    tree.thawing = true;
    const recorded = new Map<number, string>();
    for (const batch of tree.batches) {
      for (const p of batch.pids) recorded.set(p.pid, p.lstart);
      for (const g of batch.groups) recorded.set(g.pgid, g.leaderLstart);
    }
    // A pid recycled while the tree was stopped belongs to somebody else now -
    // but only an ANSWER from `ps` can say so. With no answer every recorded pid
    // is continued: a SIGCONT to a running process does nothing, and the other
    // way round leaves the tree stopped with nobody left to continue it.
    const live = await deps.lstartOf([...recorded.keys()]).catch(() => null);
    const matches = (pid: number, lstart: string): boolean => live === null || live.get(pid) === lstart;
    let recycled = 0;
    for (const batch of [...tree.batches].reverse()) {
      for (const p of [...batch.pids].reverse()) {
        if (!matches(p.pid, p.lstart)) { recycled++; continue; }
        try { deps.signal(p.pid, "SIGCONT"); } catch { /* gone */ }
      }
      for (const g of batch.groups) {
        if (!matches(g.pgid, g.leaderLstart)) { recycled++; continue; }
        try { deps.signal(-g.pgid, "SIGCONT"); } catch { /* the group is gone */ }
      }
    }
    if (recycled > 0) deps.log(`[freeze] thaw of "${tree.root.command}": ${recycled} recorded pid(s) now hold another process, not continued`);
    if (live === null) deps.log(`[freeze] thaw of "${tree.root.command}": ps did not answer, every recorded pid continued unchecked`);
    frozen.delete(tree.treeId);
    deps.ledger.release(tree.treeId);
    const t = now();
    const frozenMs = t - tree.frozenAt;
    noteInterval(tree.root.sessionKey, tree.frozenAt, t);
    try { deps.onThawTree?.(tree.root, frozenMs); } catch { /* the thaw holds anyway */ }
    deps.log(`[freeze] thawed "${tree.root.command}" after ${Math.round(frozenMs / 1000)} s: ${reason}`);
    try { deps.announce?.({ kind: "thawed", view: viewOf(tree), reason, frozenMs }); } catch { /* best effort */ }
  }

  async function thawPass(i: { swap: SwapVerdict; held: HeldMemory }): Promise<void> {
    if (frozen.size === 0) return;
    const t = now();
    const owners = new Set(deps.sessions().map((s) => s.sessionKey));
    for (const n of deps.natives()) owners.add(n.sessionKey);
    for (const tree of [...frozen.values()]) {
      const age = t - tree.frozenAt;
      const ownerGone = !owners.has(tree.root.sessionKey);
      const reason = thawReason({
        now: t,
        frozenAt: tree.frozenAt,
        ownerGone,
        sustained: i.swap.sustained,
        heldGB: i.held.heldGB,
        residentGBAtFreeze: tree.residentGBAtFreeze,
        pagesReadBackPerS: i.swap.pagesReadBackPerS,
        pagesReadBackAtFreeze: tree.pagesReadBackAtFreeze,
        effectAlreadyRead: tree.effectAlreadyRead,
      });
      if (age >= NO_EFFECT_FROM_MS && !tree.effectAlreadyRead) {
        tree.effectAlreadyRead = true;
        deps.log(
          `[freeze] effect of "${tree.root.command}" after ${Math.round(age / 1000)} s: ` +
          `swapin/s ${gb(tree.pagesReadBackAtFreeze)} -> ${gb(i.swap.pagesReadBackPerS)}, ` +
          `debt/min ${signed(tree.debtAtFreeze)} -> ${signed(i.swap.debtGBPerMin)}`,
        );
      }
      if (reason) {
        if (reason === "no effect") noEffectThisEpisode.add(tree.root.pid);
        thawedThisBeat = true;
        await thaw(tree, reason);
      }
    }
  }

  /** The candidates of this beat, measured. */
  async function measure(table: PsRow[], guard: ReadonlySet<number>): Promise<{ candidates: FreezeCandidate[]; foreground: { pid: number; command: string }[] }> {
    const byPid = new Map(table.map((r) => [r.pid, r]));
    const commandOf = (pid: number): string | undefined => byPid.get(pid)?.command;
    const { roots, foreground, unrecognised } = toolRoots({ rows: table, sessions: deps.sessions(), natives: deps.natives() });
    for (const u of unrecognised) logOncePerPid(u.pid, "unrecognised", `[freeze] unrecognised child ${u.pid} of ${u.sessionKey}: "${u.command}", never signalled`);
    const frozenRoots = new Set([...frozen.values()].map((t) => t.root.pid));
    const rootRefs = await deps.lstartOf(roots.map((r) => r.pid)).catch(() => null);
    if (rootRefs === null) {
      // No identity, no candidate. The freeze count is kept PER IDENTITY, so a
      // root whose `lstart` we cannot read would be counted from zero on every
      // beat and could be stopped without limit - and its ledger entry could not
      // be matched back at thaw time either.
      deps.log("[freeze] ps did not answer with the start times of the roots: nothing is a candidate on this beat");
      return { candidates: [], foreground: foreground.map((f) => ({ pid: f.pid, command: f.command })) };
    }
    const t = now();
    const candidates: FreezeCandidate[] = [];
    for (const root of roots) {
      if (frozenRoots.has(root.pid)) continue;
      if (noEffectThisEpisode.has(root.pid)) continue;
      const tree = descendantPids(table, root.pid);
      const cli = containsAgentCli(table, tree);
      if (cli !== null) {
        deps.log(`[freeze] skipped "${root.command}": its tree contains an agent CLI (${cli}), never frozen`);
        continue;
      }
      if ([...tree].some((p) => guard.has(p))) {
        deps.log(`[freeze] skipped "${root.command}": its tree reaches a guarded process, never frozen`);
        continue;
      }
      const xpcPids: number[] = [];
      for (const pid of tree) {
        const cmd = commandOf(pid);
        if (!cmd || !looksLikeAppExecutable(cmd)) continue;
        for (const service of await deps.xpcServicePids(pid, cmd, commandOf).catch(() => [])) {
          if (!tree.has(service) && !guard.has(service)) xpcPids.push(service);
        }
      }
      const all = [...tree, ...xpcPids];
      let footprintKB = 0;
      let residentKB = 0;
      let cpuSeconds = 0;
      for (const pid of all) {
        footprintKB += deps.footprintKB(pid) ?? 0;
        residentKB += deps.residentKB(pid) ?? 0;
        cpuSeconds += byPid.get(pid)?.cpuSeconds ?? 0;
      }
      const base = cpuBase.get(root.pid);
      cpuBase.set(root.pid, { at: t, seconds: cpuSeconds });
      // The FIRST sustained beat of a tree has no base, so its decision comes
      // ten seconds later rather than on a rate nobody measured.
      const cpuCores = base && t > base.at ? Math.max(0, (cpuSeconds - base.seconds) / ((t - base.at) / 1000)) : 0;
      const rootLstart = rootRefs.get(root.pid);
      // The root died between the table and the start times: nothing to freeze.
      if (!rootLstart) continue;
      candidates.push({
        root,
        treePids: [...tree],
        xpcPids,
        footprintGB: (footprintKB * 1024) / 1e9,
        residentGB: (residentKB * 1024) / 1e9,
        cpuCores,
        frozenCount: deps.ledger.freezeCount({ pid: root.pid, lstart: rootLstart }),
      });
    }
    return { candidates, foreground: foreground.map((f) => ({ pid: f.pid, command: f.command })) };
  }

  async function freeze(candidate: FreezeCandidate, swap: SwapVerdict): Promise<boolean> {
    // A FRESH table for the signal itself: a child forked between the walk and
    // the signal is exactly the child that keeps working while its parent is
    // stopped (the shape `killProcessTree` already pays a `ps` for).
    const table = await deps.processTable();
    if (table === null) {
      // Half a table is worse than none: the children forked since the walk
      // would keep running while their parent is stopped, and the guard set is
      // built from this very table.
      deps.log(`[freeze] refused "${candidate.root.command}": ps did not answer with a process table`);
      return false;
    }
    const guard = guardSet(table, guardRolesFor(table));
    const tree = descendantPids(table, candidate.root.pid);
    const groups = allowedGroups(table, tree, guard);
    const groupPids = new Set(groups.flatMap((g) => g.members));
    const all = new Set<number>([...tree, ...groupPids, ...candidate.xpcPids]);
    const offender = [...all].find((p) => guard.has(p));
    if (offender != null) {
      deps.log(`[freeze] refused: pid ${offender} is guarded (server, CLI, MCP or sidecar) and is in the set of "${candidate.root.command}"; freezer off`);
      disabled = true;
      return false;
    }
    // NO IDENTITY, NO SIGSTOP. `ps` mute is not "these pids have no start time":
    // recording an empty `lstart` would stop the tree and then fail to match it
    // at thaw time, leaving it `T` forever, out of the ledger and out of the
    // views - the one outcome the ledger exists to make impossible.
    const startTimes = await deps.lstartOf([...all]).catch(() => null);
    if (startTimes === null) {
      deps.log(`[freeze] refused "${candidate.root.command}": ps did not answer with the start times of its ${all.size} pids; nothing signalled`);
      return false;
    }
    const rootLstart = startTimes.get(candidate.root.pid);
    if (!rootLstart) {
      deps.log(`[freeze] refused "${candidate.root.command}": its root (pid ${candidate.root.pid}) is already gone`);
      return false;
    }
    // A pid `ps` ANSWERED about and did not list has exited since the table was
    // read: it needs no signal and has no identity to record.
    const alive = (pid: number): boolean => startTimes.has(pid);
    const ref = (pid: number): LedgerPidRef => ({ pid, lstart: startTimes.get(pid)! });
    const rootRef = ref(candidate.root.pid);
    const treeId = `${candidate.root.pid}-${candidate.root.sessionKey}-${now()}`;
    deps.ledger.begin({ treeId, sessionKey: candidate.root.sessionKey, frozenAt: now(), root: rootRef });

    const children = new Set<number>(table.filter((r) => r.ppid === candidate.root.pid).map((r) => r.pid));
    const firstGroups = groups.filter((g) => g.pgid === candidate.root.pid || children.has(g.pgid));
    const firstPids = new Set<number>([candidate.root.pid, ...children, ...firstGroups.flatMap((g) => g.members)]);
    const stoppedPids: number[] = [];
    const batches: LedgerBatch[] = [];

    const sendBatch = (allPids: number[], allGroups: { pgid: number; members: number[] }[]): void => {
      const pids = allPids.filter(alive);
      const groupsOfBatch = allGroups.filter((g) => alive(g.pgid));
      if (pids.length === 0 && groupsOfBatch.length === 0) return;
      const batch: LedgerBatch = {
        groups: groupsOfBatch.map((g) => ({ pgid: g.pgid, leaderLstart: startTimes.get(g.pgid)! })),
        pids: pids.map(ref),
      };
      // ON DISK FIRST: a SIGKILL between this line and the next leaves a
      // recorded pid that is merely running, which the boot thaw continues
      // harmlessly. The other order leaves a stopped pid nobody knows about.
      deps.ledger.addBatch(treeId, batch);
      batches.push(batch);
      deps.log(`[freeze] batch ${batches.length} of "${candidate.root.command}" (${candidate.root.sessionKey}): groups=[${batch.groups.map((g) => g.pgid).join(",")}] pids=[${pids.join(",")}] on disk, SIGSTOP`);
      for (const g of groupsOfBatch) { try { deps.signal(-g.pgid, "SIGSTOP"); } catch { /* the group is gone */ } }
      for (const pid of pids) {
        if (groupsOfBatch.some((g) => g.members.includes(pid))) continue;
        try { deps.signal(pid, "SIGSTOP"); } catch { /* already gone */ }
      }
      stoppedPids.push(...pids);
    };

    // Root first, so the driver stops issuing work before its browser stops.
    sendBatch([...firstPids], firstGroups);
    const rest = [...tree].filter((p) => !firstPids.has(p));
    const restGroups = groups.filter((g) => !firstGroups.includes(g) && rest.includes(g.pgid));
    if (rest.length) sendBatch(rest, restGroups);
    if (candidate.xpcPids.length) sendBatch(candidate.xpcPids, []);

    // POST-CHECK: every signalled pid reads `T`, and no guarded pid does. The
    // server itself is protected by the refusal above, not here: a stopped
    // server cannot run a post-check.
    const undo = (): void => {
      for (const pid of [...stoppedPids].reverse()) { try { deps.signal(pid, "SIGCONT"); } catch { /* gone */ } }
      for (const g of groups) { try { deps.signal(-g.pgid, "SIGCONT"); } catch { /* gone */ } }
      deps.ledger.release(treeId);
    };
    const guardSample = [...guard].filter((p) => p !== guardRolesFor(table).serverPid).slice(0, 200);
    const stats = await deps.statOf([...stoppedPids, ...guardSample]).catch(() => null);
    if (stats === null) {
      // The invariant itself is held by the refusal above, on the same table:
      // this reading only corroborates it. Undoing a freeze because `ps` went
      // quiet would cost the lever the one beat it gets every 120 s and buy a
      // certainty nobody can measure, so the freeze stands and says so.
      deps.log(`[freeze] post-check of "${candidate.root.command}" skipped: ps did not answer; the guard was still checked before the first signal`);
    } else {
      const guardStopped = guardSample.find((p) => stats.get(p)?.startsWith("T"));
      if (guardStopped != null) {
        deps.log(`[freeze] guard tripped: pid ${guardStopped} reads T after the freeze of "${candidate.root.command}"; continuing everything, freezer off`);
        undo();
        disabled = true;
        return false;
      }
      // The OTHER half, which was measured and then thrown away: a tree whose
      // every SIGSTOP failed (a command that is not ours to signal) used to be
      // announced as frozen, frost and all, while it went on touching pages.
      const known = stoppedPids.filter((p) => stats.has(p));
      if (known.length > 0 && !known.some((p) => stats.get(p)!.startsWith("T"))) {
        deps.log(`[freeze] no effect: none of the ${known.length} signalled pid(s) of "${candidate.root.command}" reads T; nothing is frozen`);
        undo();
        // And it is not tried again in this episode: the next beat would spend
        // its one action on the same non-freeze instead of the next heaviest.
        noEffectThisEpisode.add(candidate.root.pid);
        return false;
      }
    }

    const at = now();
    const n = deps.ledger.bumpCount(rootRef, at);
    const tree_: FrozenTree = {
      treeId,
      root: candidate.root,
      rootRef,
      batches,
      stoppedPids,
      frozenAt: at,
      n,
      footprintGB: candidate.footprintGB,
      residentGBAtFreeze: candidate.residentGB,
      pagesReadBackAtFreeze: swap.pagesReadBackPerS,
      debtAtFreeze: swap.debtGBPerMin,
      effectAlreadyRead: false,
      thawing: false,
    };
    frozen.set(treeId, tree_);
    lastFreezeAt = at;
    try { deps.onFreezeTree?.(candidate.root); } catch { /* the freeze holds anyway */ }
    deps.log(
      `[freeze] froze "${candidate.root.command}": tree ${gb(candidate.footprintGB)} GB footprint, ${gb(candidate.residentGB)} GB resident, ` +
      `${candidate.cpuCores.toFixed(2)} core, ${candidate.treePids.length} pids + ${candidate.xpcPids.length} XPC [${candidate.xpcPids.join(",")}], ` +
      `${candidate.root.kind}; ${swapSigns(swap)}; ` +
      `thaw by ${new Date(at + FREEZE_MAX_MS).toISOString()}; guard disjoint; freeze ${n} of ${FREEZES_PER_TREE}`,
    );
    try { deps.announce?.({ kind: "frozen", view: viewOf(tree_) }); } catch { /* best effort */ }
    if (candidate.root.taskId && deps.note) {
      try {
        deps.note(candidate.root.taskId,
          `Comando congelato, non fermato: ${swapReasonIt(swap)} e \`${candidate.root.command}\` teneva ${gb(candidate.footprintGB)} GB. ` + // allow-italian: board notes are written in Italian like every other service comment
          "Riprende da solo quando c'è memoria, al più tardi fra 10 minuti. " + // allow-italian: board notes are written in Italian like every other service comment
          `Un'operazione con un timeout in corso può scadere alla ripresa. Congelamento ${n} di ${FREEZES_PER_TREE}.`); // allow-italian: board notes are written in Italian like every other service comment
      } catch { /* a note that cannot be written must not stop the freeze */ }
    }
    return true;
  }

  return {
    async tick({ swap, held, brake }) {
      if (ticking) return;
      ticking = true;
      thawedThisBeat = false;
      try {
        await thawPass({ swap, held });
        if (disabled || !swap.sustained) {
          if (!swap.sustained) { episodeSince = null; saidNothing = false; saidExhausted = false; noEffectThisEpisode.clear(); namedPids.clear(); }
          return;
        }
        // A beat that has just continued a tree does not freeze another: the
        // machine has not yet been given a chance to answer the first act.
        if (thawedThisBeat) return;
        episodeSince ??= now();
        const t = now();
        // The two levers share one window: `lastActionAt` is the later of the
        // brake's own interruption and this freezer's last freeze.
        if (t - lastFreezeAt < SWAP_ACTION_SPACING_MS) return;
        // The brake goes first: a killed round restarts by itself and gives
        // memory back, which a freeze never does.
        if (brake.interrupted) return;
        if (brake.skipped !== "noHeavyRun" && brake.skipped !== "exhausted") return;
        const table = await deps.processTable();
        if (table === null) {
          deps.log("[freeze] ps did not answer with a process table on this beat: nothing measured, nothing signalled");
          return;
        }
        const guard = guardSet(table, guardRolesFor(table));
        // A count outlives its thaw on purpose, but not the machine: without
        // this the file grows for every tree ever frozen, with an fsync each.
        const livePids = new Set(table.map((r) => r.pid));
        deps.ledger.pruneCounts((c) => livePids.has(c.pid));
        for (const pid of namedPids.keys()) if (!livePids.has(pid)) namedPids.delete(pid);
        const { candidates, foreground } = await measure(table, guard);
        for (const f of foreground) logOncePerPid(f.pid, "foreground", `[freeze] skipped "${f.command}" (pid ${f.pid}): foreground Bash, never frozen`);
        let { victim, skipped } = pickVictim(candidates);
        // A tree serving somebody outside itself is skipped for the next heaviest.
        const tried = new Set<ToolRoot>();
        while (victim) {
          tried.add(victim.root);
          const peers = await deps.outsidePeers([...victim.treePids, ...victim.xpcPids]).catch(() => null);
          if (peers !== null && peers.length === 0) break;
          deps.log(peers === null
            ? `[freeze] skipped "${victim.root.command}": lsof did not answer, so who is connected to it was never measured`
            : `[freeze] skipped "${victim.root.command}": ${peers.length} established peer(s) outside its tree`);
          ({ victim, skipped } = pickVictim(candidates.filter((c) => !tried.has(c.root))));
        }
        if (!victim) {
          if (skipped === "exhausted" && !saidExhausted) {
            saidExhausted = true;
            deps.log(`[freeze] every candidate has been frozen ${FREEZES_PER_TREE} times on this incarnation: it runs to the end`);
          }
          if (skipped === "belowFloor" && !saidNothing) {
            saidNothing = true;
            deps.log(`[freeze] swap sustained, brake had nothing, no background or native agent command >= ${FREEZE_MIN_GB} GB with CPU: nothing to freeze`);
          }
          return;
        }
        await freeze(victim, swap);
      } catch (err) {
        deps.log(`[freeze] beat failed: ${String(err)}`);
      } finally {
        ticking = false;
      }
    },

    async release(sessionKey) {
      for (const tree of [...frozen.values()]) {
        if (tree.root.sessionKey === sessionKey) await thaw(tree, "owner gone");
      }
    },

    async thawAll(reason = "shutdown") {
      for (const tree of [...frozen.values()]) await thaw(tree, reason);
    },

    views: () => [...frozen.values()].map(viewOf),
    isHold: (sessionKey) => [...frozen.values()].some((t) => t.root.sessionKey === sessionKey),
    frozenMsSince(sessionKey, t) {
      const at = now();
      let total = 0;
      for (const span of history.get(sessionKey) ?? []) {
        total += Math.max(0, Math.min(span.to, at) - Math.max(span.from, t));
      }
      for (const tree of frozen.values()) {
        if (tree.root.sessionKey !== sessionKey) continue;
        total += Math.max(0, at - Math.max(tree.frozenAt, t));
      }
      return total;
    },
    frozenCount: () => frozen.size,
    frozenGB: () => [...frozen.values()].reduce((sum, t) => sum + t.footprintGB, 0),
    lastActionAt: () => lastFreezeAt,
  };
}
