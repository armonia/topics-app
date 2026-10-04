/**
 * The per-project index behind `projectAttention` / `projectAttentionChildren`
 * (`state/attentionRollups.ts`, notifications-redesign).
 *
 * Two questions, and only two. First, PARITY: the indexed walk must answer
 * exactly what a full scan answers, on generated states that mix every
 * attention tier with archived and standalone children. The oracle is kept
 * in this file on purpose: an expectation typed by hand would only pin what
 * the author remembered of the rules (archived out, standalone out, shells
 * out, a terminal under the project's cwd in).
 *
 * Second, COST: the sidebar and the tab bar call these helpers for every
 * project on every attention frame, over a map whose bulk is the archive. The
 * index answers from the project's own bucket, so a thousand calls stay
 * cheap.
 *
 * @covers PARITY-01, ATTN-COST-01, ATTN-12
 */
import { describe, test, expect } from "bun:test";
import { projectAttention, projectAttentionChildren } from "./attentionRollups";
import { attentionOf, rollupAttention, type AttentionRows } from "./attention";
import type { AttentionSnapshot, AttentionState } from "../../../shared/attention";
import type { Topic, TerminalSessionInfo } from "../types";

const topic = (id: string, over: Partial<Topic> = {}): Topic =>
  ({ id, name: id, ...over } as Topic);

const term = (id: string, cwd: string, over: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo =>
  ({ id, name: id, cwd, type: "claude-code", ...over } as TerminalSessionInfo);

function belongs(cwd: string, projectPath: string): boolean {
  return cwd === projectPath || cwd.startsWith(projectPath + "/");
}

/** ORACLE: one pass over every topic in the map, archive included. */
function oracle(projectPath: string, topics: Record<string, Topic>, terminals: TerminalSessionInfo[], rows: AttentionRows) {
  const subjects: string[] = [];
  for (const t of Object.values(topics)) {
    if (t.projectPath !== projectPath || t.archived || t.standalone) continue;
    subjects.push(`topic:${t.id}`);
  }
  for (const ts of terminals) {
    if (ts.type === "shell" || !ts.cwd || !belongs(ts.cwd, projectPath)) continue;
    subjects.push(`terminal:${ts.id}`);
  }
  const lit = subjects.filter((s) => attentionOf(rows, s).lit);
  return { ...rollupAttention(subjects.map((s) => attentionOf(rows, s))), lit };
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PROJECTS = ["/w/alpha", "/w/beta", "/w/gamma"];
const STATES: AttentionState[] = ["idle", "working", "needs-you", "finished"];

function row(subject: string, state: AttentionState, lit: boolean, error: boolean): AttentionSnapshot {
  return {
    subject, state, reason: state === "needs-you" ? "question" : null, outcome: state === "finished" ? (error ? "error" : "done") : null,
    detail: null, since: "", epoch: 1, seenEpoch: lit ? 0 : 1, lit: state === "needs-you" || (state === "finished" && lit),
    unread: 0, turnUnseen: false, lastTurnAt: null, background: [],
  };
}

function generateCase(seed: number) {
  const rand = seededRandom(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const topics: Record<string, Topic> = {};
  const rows = new Map<string, AttentionSnapshot>();
  for (let i = 0; i < 40; i++) {
    const id = `t${i}`;
    topics[id] = topic(id, { projectPath: rand() < 0.85 ? pick(PROJECTS) : undefined, archived: rand() < 0.4, standalone: rand() < 0.3 });
    if (rand() < 0.7) rows.set(`topic:${id}`, row(`topic:${id}`, pick(STATES), rand() < 0.6, rand() < 0.3));
  }
  const terminals: TerminalSessionInfo[] = [];
  for (let i = 0; i < 8; i++) {
    const id = `s${i}`;
    terminals.push(term(id, `${pick(PROJECTS)}${rand() < 0.5 ? "/sub" : ""}`, { type: rand() < 0.25 ? "shell" : "claude-code" }));
    if (rand() < 0.7) rows.set(`terminal:${id}`, row(`terminal:${id}`, pick(STATES), rand() < 0.6, rand() < 0.3));
  }
  return { topics, terminals, rows };
}

describe("project attention index - same answers as the full scan", () => {
  test("tier, count and lit children match the oracle on 200 generated states", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const c = generateCase(seed);
      for (const p of [...PROJECTS, "/w/unknown"]) {
        const want = oracle(p, c.topics, c.terminals, c.rows);
        const got = projectAttention(c.rows, p, c.topics, c.terminals);
        const children = projectAttentionChildren(c.rows, p, c.topics, c.terminals).map((x) => x.subject);
        expect({ seed, p, tier: got.tier, count: got.count, lit: children }).toEqual({ seed, p, tier: want.tier, count: want.count, lit: want.lit });
      }
    }
  });

  test("the rollup follows a topic that is archived or unarchived under a new map identity", () => {
    const live = { a: topic("a", { projectPath: "/w/alpha" }) };
    const archived = { a: topic("a", { projectPath: "/w/alpha", archived: true }) };
    const rows = new Map([["topic:a", row("topic:a", "finished", true, false)]]);
    expect(projectAttention(rows, "/w/alpha", live, []).tier).toBe("done");
    expect(projectAttention(rows, "/w/alpha", archived, []).tier).toBeNull();
    expect(projectAttention(rows, "/w/alpha", live, []).tier).toBe("done");
  });
});

describe("project attention index - cost", () => {
  test("1,000 rollups over 1,500 archived topics stay under 5 ms", () => {
    const topics: Record<string, Topic> = {};
    const projects = Array.from({ length: 8 }, (_, i) => `/w/p${i}`);
    for (let i = 0; i < 1500; i++) topics[`old${i}`] = topic(`old${i}`, { projectPath: projects[i % projects.length], archived: true });
    for (let i = 0; i < 17; i++) topics[`live${i}`] = topic(`live${i}`, { projectPath: projects[i % projects.length] });
    const rows = new Map([["topic:live3", row("topic:live3", "finished", true, false)]]);
    // One warm-up call: the first call over a map builds the index.
    projectAttention(rows, projects[0]!, topics, []);
    const started = performance.now();
    for (let i = 0; i < 1000; i++) projectAttention(rows, projects[i % projects.length]!, topics, []);
    expect(performance.now() - started).toBeLessThan(5);
  });
});
