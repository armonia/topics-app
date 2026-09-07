/**
 * The per-project index behind `projectAttentionTier` / `projectAttentionSubjects`.
 *
 * Two questions, and only two. First, PARITY: the indexed walk must answer
 * exactly what the full scan answered, on generated states that mix awaiting /
 * input / seen with archived and standalone children. The oracle is kept in
 * this file on purpose - it IS the previous implementation, copied - because an
 * expectation typed by hand would only pin what the author remembered of the
 * rules, and the rules here (archived out of both, standalone out of the tier
 * but IN the subjects) are exactly the part one forgets.
 *
 * Second, COST: the sidebar and the tab bar call these helpers for every
 * project on every activity tick, so what matters is not one call but a
 * thousand of them over a map whose bulk is the archive. On the map this was
 * measured against - 1,500 archived topics for 17 live ones - the full scan
 * spent ~300 ms for 1,000 calls of `projectAttentionTier`. The index answers
 * from the project's own bucket, so the same thousand calls stay under 5 ms.
 *
 * @covers PARITY-01, ATTN-COST-01
 */
import { describe, test, expect } from "bun:test";
import { projectAttentionTier, projectAttentionSubjects, topicAttentionCount, terminalAttentionCount } from "./signals";
import type { Topic, TerminalSessionInfo, AttentionTier } from "../types";

const topic = (id: string, over: Partial<Topic> = {}): Topic =>
  ({ id, name: id, ...over } as Topic);

const term = (id: string, cwd: string, over: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo =>
  ({ id, name: id, cwd, type: "claude-code", ...over } as TerminalSessionInfo);

const unreadOf = (counts: Record<string, number>): Record<string, { unreadCount: number }> =>
  Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, { unreadCount: n }]));

/** A terminal belongs to a project when its cwd is the project or under it -
 *  the same containment rule the helpers use, restated for the oracle. */
function belongs(cwd: string, projectPath: string): boolean {
  if (!cwd || !projectPath) return false;
  const c = cwd.replace(/\/+$/, "");
  const p = projectPath.replace(/\/+$/, "");
  return c === p || c.startsWith(p + "/");
}

/** ORACLE - `projectAttentionTier` as it was before the index: one pass over
 *  every topic in the map, archive included. Do not "simplify" it: its job is
 *  to disagree with the new code if the new code changes an answer. */
function tierOracle(
  projectPath: string,
  topics: Record<string, Topic>,
  terminalSessions: TerminalSessionInfo[],
  awaitingTopics: ReadonlySet<string>,
  awaitingTerms: ReadonlySet<string>,
  inputTopics: ReadonlySet<string>,
  inputTerms: ReadonlySet<string>,
  seenSubjects?: ReadonlySet<string>,
): AttentionTier | null {
  let hasDone = false;
  for (const t of Object.values(topics)) {
    if (t.projectPath !== projectPath) continue;
    if (t.archived) continue;
    if (t.standalone) continue;
    if (seenSubjects?.has(t.id)) continue;
    if (inputTopics.has(t.id)) return "input";
    if (awaitingTopics.has(t.id)) hasDone = true;
  }
  for (const ts of terminalSessions) {
    if (ts.type === "shell") continue;
    if (!ts.cwd || !belongs(ts.cwd, projectPath)) continue;
    if (seenSubjects?.has(ts.id)) continue;
    if (inputTerms.has(ts.id)) return "input";
    if (awaitingTerms.has(ts.id)) hasDone = true;
  }
  return hasDone ? "done" : null;
}

/** ORACLE - `projectAttentionSubjects` as it was before the index. Note the
 *  asymmetry with the tier: standalone children DO count here. */
function subjectsOracle(
  projectPath: string,
  topics: Record<string, Topic>,
  terminalSessions: TerminalSessionInfo[],
  unread: Record<string, { unreadCount: number } | undefined>,
  claudeAttentionTopics: Set<string>,
  terminalFinishedIds: Set<string>,
) {
  const out: { id: string; kind: "chat" | "terminal"; name: string; count: number }[] = [];
  for (const t of Object.values(topics)) {
    if (t.projectPath !== projectPath) continue;
    if (t.archived) continue;
    const count = topicAttentionCount(t.id, unread, claudeAttentionTopics);
    if (count > 0) out.push({ id: t.id, kind: "chat", name: t.name || "Chat", count });
  }
  if (terminalFinishedIds.size) {
    for (const ts of terminalSessions) {
      if (ts.type === "shell") continue;
      if (!ts.cwd || !belongs(ts.cwd, projectPath)) continue;
      const count = terminalAttentionCount(ts.id, terminalFinishedIds);
      if (count > 0) out.push({ id: ts.id, kind: "terminal", name: ts.name || ts.type || "Terminale", count });
    }
  }
  return out;
}

/** Deterministic generator: a seeded LCG, so a red is reproducible from the
 *  seed printed in the failure instead of "it happens sometimes". */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PROJECTS = ["/w/alpha", "/w/beta", "/w/gamma"];

function generateCase(seed: number) {
  const rand = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const topics: Record<string, Topic> = {};
  const awaitingTopics = new Set<string>();
  const inputTopics = new Set<string>();
  const seenSubjects = new Set<string>();
  const claudeAttentionTopics = new Set<string>();
  const unreadCounts: Record<string, number> = {};
  for (let i = 0; i < 40; i++) {
    const id = `t${i}`;
    const hasProject = rand() < 0.85;
    topics[id] = topic(id, {
      projectPath: hasProject ? pick(PROJECTS) : undefined,
      archived: rand() < 0.4,
      standalone: rand() < 0.3,
    });
    if (rand() < 0.3) awaitingTopics.add(id);
    if (rand() < 0.2) inputTopics.add(id);
    if (rand() < 0.25) seenSubjects.add(id);
    if (rand() < 0.3) claudeAttentionTopics.add(id);
    if (rand() < 0.3) unreadCounts[id] = 1 + Math.floor(rand() * 3);
  }
  const terminalSessions: TerminalSessionInfo[] = [];
  const awaitingTerms = new Set<string>();
  const inputTerms = new Set<string>();
  const terminalFinishedIds = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const id = `s${i}`;
    terminalSessions.push(term(id, `${pick(PROJECTS)}${rand() < 0.5 ? "/sub" : ""}`, {
      type: rand() < 0.25 ? "shell" : "claude-code",
    }));
    if (rand() < 0.3) awaitingTerms.add(id);
    if (rand() < 0.2) inputTerms.add(id);
    if (rand() < 0.2) seenSubjects.add(id);
    if (rand() < 0.3) terminalFinishedIds.add(id);
  }
  return {
    topics, terminalSessions, awaitingTopics, awaitingTerms, inputTopics, inputTerms,
    seenSubjects, claudeAttentionTopics, terminalFinishedIds, unread: unreadOf(unreadCounts),
  };
}

describe("project attention index - same answers as the full scan", () => {
  test("tier and subjects match the oracle on 200 generated states", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const c = generateCase(seed);
      for (const p of [...PROJECTS, "/w/unknown"]) {
        const got = projectAttentionTier(
          p, c.topics, c.terminalSessions, c.awaitingTopics, c.awaitingTerms,
          c.inputTopics, c.inputTerms, c.seenSubjects,
        );
        const want = tierOracle(
          p, c.topics, c.terminalSessions, c.awaitingTopics, c.awaitingTerms,
          c.inputTopics, c.inputTerms, c.seenSubjects,
        );
        expect({ seed, p, got }).toEqual({ seed, p, got: want });

        const gotSubjects = projectAttentionSubjects(
          p, c.topics, c.terminalSessions, c.unread, c.claudeAttentionTopics, c.terminalFinishedIds,
        );
        const wantSubjects = subjectsOracle(
          p, c.topics, c.terminalSessions, c.unread, c.claudeAttentionTopics, c.terminalFinishedIds,
        );
        expect({ seed, p, subjects: gotSubjects }).toEqual({ seed, p, subjects: wantSubjects });
      }
    }
  });

  test("the tier follows a topic that is archived or unarchived under the same map identity", () => {
    // The index is keyed by the identity of the topics map, and the app builds
    // a NEW map on every change (mergeBuckets is a useMemo over the buckets).
    // Two different maps, two different answers: this is the case that would
    // break if the index were keyed by project path alone.
    const live = { a: topic("a", { projectPath: "/w/alpha" }) };
    const archived = { a: topic("a", { projectPath: "/w/alpha", archived: true }) };
    const awaiting = new Set(["a"]);
    const empty = new Set<string>();
    expect(projectAttentionTier("/w/alpha", live, [], awaiting, empty, empty, empty)).toBe("done");
    expect(projectAttentionTier("/w/alpha", archived, [], awaiting, empty, empty, empty)).toBeNull();
    expect(projectAttentionTier("/w/alpha", live, [], awaiting, empty, empty, empty)).toBe("done");
  });
});

describe("project attention index - cost", () => {
  test("1,000 tier calls over 1,500 archived topics stay under 5 ms", () => {
    const topics: Record<string, Topic> = {};
    const projects = Array.from({ length: 8 }, (_, i) => `/w/p${i}`);
    for (let i = 0; i < 1500; i++) {
      topics[`old${i}`] = topic(`old${i}`, { projectPath: projects[i % projects.length], archived: true });
    }
    for (let i = 0; i < 17; i++) {
      topics[`live${i}`] = topic(`live${i}`, { projectPath: projects[i % projects.length] });
    }
    const awaiting = new Set(["live3"]);
    const empty = new Set<string>();
    // One warm-up call: the first call over a map builds the index, and what is
    // measured is the steady state the sidebar lives in (same map, many calls).
    projectAttentionTier(projects[0]!, topics, [], awaiting, empty, empty, empty);
    const started = performance.now();
    for (let i = 0; i < 1000; i++) {
      projectAttentionTier(projects[i % projects.length]!, topics, [], awaiting, empty, empty, empty);
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(5);
  });
});
