/**
 * Tests for the unified attention helpers — the single definition of "this
 * needs you", shared by the tab bar (getBadgeCount / getProjectBadgeCount) and
 * the sidebar (buildSidebarItems). The whole point of these helpers is that the
 * two surfaces can't drift, so the contract worth pinning is:
 *   - a chat counts max(unread, Claude-needs-you), never the sum;
 *   - a terminal counts a finished-but-unseen turn;
 *   - a project rolls up its children, excludes lead (Master) topics, and so
 *     produces the SAME number regardless of whether it's handed the full topic
 *     map (tab bar) or the lead-filtered one (sidebar).
 *
 * @covers MUTE-01, PARITY-01
 */
import { describe, test, expect } from "bun:test";
import {
  topicAttentionCount, terminalAttentionCount, rollupProjectAttention, rollupGlobalAttention,
  attentionTierForPhase, deriveAwaitingFeedbackTopics, deriveAwaitingInputTopics,
  derivePhaseTerminals, projectAttentionTier, deriveSessionActivity,
} from "./signals";
import type { Topic, TerminalSessionInfo, ClaudeSessionState } from "../types";

const unread = (counts: Record<string, number>): Record<string, { unreadCount: number }> =>
  Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, { unreadCount: n }]));

// Minimal Topic factory — only the fields the rollup reads.
const topic = (id: string, over: Partial<Topic> = {}): Topic =>
  ({ id, name: id, ...over } as Topic);

// Minimal terminal — only id + cwd matter to the rollup.
const term = (id: string, cwd: string): TerminalSessionInfo =>
  ({ id, cwd } as TerminalSessionInfo);

describe("topicAttentionCount", () => {
  test("uses server unread when there's no Claude attention", () => {
    expect(topicAttentionCount("t", unread({ t: 3 }), new Set())).toBe(3);
  });

  test("counts Claude needs-you as 1 even with zero unread", () => {
    expect(topicAttentionCount("t", unread({}), new Set(["t"]))).toBe(1);
  });

  test("takes the max, never the sum (no double counting)", () => {
    // unread 5 + needs-you should still read as 5, not 6.
    expect(topicAttentionCount("t", unread({ t: 5 }), new Set(["t"]))).toBe(5);
    // needs-you (1) beats a single unread (1) → still 1, not 2.
    expect(topicAttentionCount("t", unread({ t: 1 }), new Set(["t"]))).toBe(1);
  });

  test("is zero when nothing is pending", () => {
    expect(topicAttentionCount("t", unread({}), new Set())).toBe(0);
  });
});

describe("terminalAttentionCount", () => {
  test("a finished-but-unseen claude-code turn counts 1", () => {
    expect(terminalAttentionCount("s", new Set(["s"]))).toBe(1);
  });
  test("zero when not finished", () => {
    expect(terminalAttentionCount("s", new Set())).toBe(0);
  });
});

describe("rollupProjectAttention", () => {
  const PROJ = "/work/app";

  test("sums child chat attention + finished terminals under the project", () => {
    const topics = {
      a: topic("a", { projectPath: PROJ }),
      b: topic("b", { projectPath: PROJ }),
      other: topic("other", { projectPath: "/work/elsewhere" }),
    };
    const terminals = [term("term1", `${PROJ}/sub`), term("term2", "/work/elsewhere")];
    const sum = rollupProjectAttention(
      PROJ,
      topics,
      terminals,
      unread({ a: 2 }),          // a: 2 unread
      new Set(["b"]),            // b: Claude needs-you (1)
      new Set(["term1"]),        // term1 finished (1) — under the project
    );
    // 2 (a) + 1 (b) + 1 (term1). `other` and `term2` belong to another project.
    expect(sum).toBe(4);
  });

  test("zero for a project with no pending attention", () => {
    const topics = { a: topic("a", { projectPath: PROJ }) };
    expect(rollupProjectAttention(PROJ, topics, [], unread({}), new Set(), new Set())).toBe(0);
  });
});

describe("rollupGlobalAttention", () => {
  test("sums every topic's attention across ALL projects + all finished terminals", () => {
    const topics = {
      a: topic("a", { projectPath: "/work/app" }),
      b: topic("b", { projectPath: "/work/elsewhere" }),
      c: topic("c"), // no project
    };
    const sum = rollupGlobalAttention(
      topics,
      unread({ a: 2, c: 1 }),   // a: 2 unread, c: 1 unread
      new Set(["b"]),           // b: Claude needs-you (1)
      new Set(["t1", "t2"]),    // two finished terminal turns (project-agnostic)
    );
    // 2 (a) + 1 (b) + 1 (c) + 2 (terminals) = 6. Unlike the project rollup, no
    // cwd/project filtering — every subject counts once toward the dock badge.
    expect(sum).toBe(6);
  });

  test("is zero when nothing anywhere is pending", () => {
    const topics = { a: topic("a"), b: topic("b") };
    expect(rollupGlobalAttention(topics, unread({}), new Set(), new Set())).toBe(0);
  });

  test("takes max(unread, needs-you) per chat — never double counts", () => {
    const topics = { a: topic("a") };
    // a is BOTH 3-unread AND needs-you → still 3 (max), plus no terminals.
    expect(rollupGlobalAttention(topics, unread({ a: 3 }), new Set(["a"]), new Set())).toBe(3);
  });
});

// ─── Attention TIER split (amber "act now" vs blue "done, look when ready") ───

const sess = (over: Partial<ClaudeSessionState> = {}): ClaudeSessionState => ({
  sessionKey: null, claudeSessionId: "c", phase: "running",
  // `jsonlOffset`/`createdAt` sono obbligatori sul filo (il tracker li scrive
  // sempre): senza, questa fixture era una sessione che il server non produce.
  phaseUpdatedAt: 1000, jsonlOffset: 0, rev: 1, createdAt: 1000, updatedAt: 1000, ...over,
});

describe("attentionTierForPhase", () => {
  test("awaiting-approval is the LOUD 'input' tier", () => {
    expect(attentionTierForPhase("awaiting-approval")).toBe("input");
  });
  test("awaiting-user and paused are the calm 'done' tier", () => {
    expect(attentionTierForPhase("awaiting-user")).toBe("done");
    expect(attentionTierForPhase("paused")).toBe("done");
  });
  test("working/error/idle phases have no tier (badge handles error)", () => {
    for (const p of ["running", "tool-running", "error", "completed", "dormant", "starting"] as const) {
      expect(attentionTierForPhase(p)).toBeNull();
    }
  });
});

describe("deriveAwaitingInputTopics ⊂ deriveAwaitingFeedbackTopics", () => {
  const topics = {
    t1: topic("t1", { sessionKey: "k1" }),
    t2: topic("t2", { sessionKey: "k2" }),
    t3: topic("t3", { sessionKey: "k3" }),
    t4: topic("t4", { sessionKey: "k4" }),
  };
  const sessions = new Map<string, ClaudeSessionState>([
    ["k1", sess({ sessionKey: "k1", phase: "awaiting-approval" })],
    ["k2", sess({ sessionKey: "k2", phase: "awaiting-user" })],
    ["k3", sess({ sessionKey: "k3", phase: "paused" })],
    ["k4", sess({ sessionKey: "k4", phase: "running" })],
  ]);

  test("feedback = all awaiting (approval + user + paused), not running", () => {
    expect(deriveAwaitingFeedbackTopics(topics, sessions)).toEqual(new Set(["t1", "t2", "t3"]));
  });
  test("input = only the awaiting-approval subset", () => {
    expect(deriveAwaitingInputTopics(topics, sessions)).toEqual(new Set(["t1"]));
  });
});

describe("derivePhaseTerminals — awaitingInput is a subset of awaiting", () => {
  const roster = [
    { id: "term-appr", type: "claude-code", claudeSessionId: "a" },
    { id: "term-user", type: "claude-code", claudeSessionId: "u" },
    { id: "term-run", type: "claude-code", claudeSessionId: "r" },
    { id: "shell", type: "shell", claudeSessionId: null },
  ];
  const byCsid = new Map([
    ["a", { phase: "awaiting-approval" as const }],
    ["u", { phase: "awaiting-user" as const }],
    ["r", { phase: "running" as const }],
  ]);

  test("splits awaiting into the amber input subset and leaves the rest blue", () => {
    const { active, awaiting, awaitingInput } = derivePhaseTerminals(roster, byCsid);
    expect(active).toEqual(new Set(["term-run"]));
    expect(awaiting).toEqual(new Set(["term-appr", "term-user"]));
    expect(awaitingInput).toEqual(new Set(["term-appr"])); // only the permission gate
  });
});

describe("projectAttentionTier — loudest child wins", () => {
  const PROJ = "/work/app";
  const topics = {
    a: topic("a", { projectPath: PROJ }),
    b: topic("b", { projectPath: PROJ }),
  };
  test("'input' if any child is awaiting a permission", () => {
    expect(projectAttentionTier(PROJ, topics, [], new Set(["a", "b"]), new Set(), new Set(["b"]), new Set())).toBe("input");
  });
  test("'done' when children are only finished-unseen", () => {
    expect(projectAttentionTier(PROJ, topics, [], new Set(["a"]), new Set(), new Set(), new Set())).toBe("done");
  });
  test("null when no child needs you", () => {
    expect(projectAttentionTier(PROJ, topics, [], new Set(), new Set(), new Set(), new Set())).toBeNull();
  });
});

/**
 * Il "visto" nel rollup — perché la tab «Progetto» restava segnalata.
 *
 * Una fase Claude come `awaiting-user` non si spegne da sola: resta fino al turno
 * dopo. Per una chat il fill lo spegne il "visto"; questo rollup però leggeva gli
 * insiemi grezzi, quindi il progetto continuava a segnalare un figlio già letto e
 * l'unica cosa che lo nascondeva era «la tab è attiva adesso» — un gate che cade
 * appena selezioni un'altra tab. Qui si fissa il pezzo DUREVOLE: il progetto
 * segnala solo ciò che non hai ancora guardato. Il gate transitorio resta nei
 * chiamanti come valvola per i figli irraggiungibili (una sessione nel roster
 * senza riga né tab non può essere marcata vista da nessuno).
 */
describe("projectAttentionTier — un figlio già VISTO non segnala più", () => {
  const PROJ = "/work/app";
  const topics = {
    a: topic("a", { projectPath: PROJ }),
    b: topic("b", { projectPath: PROJ }),
  };
  const S = (...ids: string[]) => new Set(ids);

  test("l'unico figlio in attesa è stato visto ⇒ il progetto tace", () => {
    expect(projectAttentionTier(PROJ, topics, [], S("a"), S(), S(), S(), S("a"))).toBeNull();
  });

  test("visto un figlio, ne resta un altro non visto ⇒ segnala ancora", () => {
    expect(projectAttentionTier(PROJ, topics, [], S("a", "b"), S(), S(), S(), S("a"))).toBe("done");
  });

  test("il figlio AMBRA visto non declassa: vince quello che resta", () => {
    // 'b' chiede un permesso (input) ma l'hai guardato; 'a' ha solo finito il turno.
    expect(projectAttentionTier(PROJ, topics, [], S("a", "b"), S(), S("b"), S(), S("b"))).toBe("done");
    // Se invece l'ambra NON è vista, vince lei.
    expect(projectAttentionTier(PROJ, topics, [], S("a", "b"), S(), S("b"), S(), S("a"))).toBe("input");
  });

  test("vale anche per i terminali claude-code sotto il progetto", () => {
    const terminals = [{ id: "t1", cwd: `${PROJ}/sub`, type: "claude-code" } as TerminalSessionInfo];
    expect(projectAttentionTier(PROJ, {}, terminals, S(), S("t1"), S(), S())).toBe("done");
    expect(projectAttentionTier(PROJ, {}, terminals, S(), S("t1"), S(), S(), S("t1"))).toBeNull();
  });

  test("omettere seenSubjects lascia il rollup GREZZO", () => {
    expect(projectAttentionTier(PROJ, topics, [], S("a"), S(), S(), S())).toBe("done");
  });

  test("un ARCHIVIATO non accende: è la chat CHIUSA che non ha dove essere spenta", () => {
    // Misurato sulla macchina vera: 6 dei 6 figli che tenevano segnalato
    // `topics-app` erano archiviati, fermi su `awaiting-user`. Una chat chiusa non
    // ha riga né tab, quindi nessuna soglia può marcarla vista e il progetto
    // resterebbe acceso per sempre. Stessa scelta di `visibleTopicSignalCount`.
    const withArchived = { z: topic("z", { projectPath: PROJ, archived: true }) };
    expect(projectAttentionTier(PROJ, withArchived, [], S("z"), S(), S("z"), S())).toBeNull();
    // …e non è il "visto" a spegnerlo: non conta proprio.
    expect(projectAttentionTier(PROJ, withArchived, [], S("z"), S(), S("z"), S(), S())).toBeNull();
  });
});

describe("rollupProjectAttention — il BADGE ha la stessa causa del fill", () => {
  const PROJ = "/work/app";
  test("una chat CHIUSA parcheggiata su awaiting non tiene appeso il numero", () => {
    const topics = {
      viva: topic("viva", { projectPath: PROJ }),
      chiusa: topic("chiusa", { projectPath: PROJ, archived: true }),
    };
    // Entrambe hanno l'attenzione di Claude; solo la viva la può azzerare.
    expect(rollupProjectAttention(PROJ, topics, [], unread({}), new Set(["viva", "chiusa"]), new Set())).toBe(1);
  });
});

describe("deriveSessionActivity", () => {
  const topics = {
    work: topic("work", { sessionKey: "kw" }),
    appr: topic("appr", { sessionKey: "ka" }),
    idle: topic("idle", { sessionKey: "ki" }),
  };
  const sessions = new Map<string, ClaudeSessionState>([
    ["kw", sess({ sessionKey: "kw", phase: "tool-running", lastTool: { name: "Bash", startedAt: 2000 } })],
    ["ka", sess({ sessionKey: "ka", phase: "awaiting-approval", pendingApproval: { kind: "edit", prompt: "?", requestedAt: 1500 } })],
    ["ki", sess({ sessionKey: "ki", phase: "completed" })],
  ]);
  const activity = deriveSessionActivity(topics, [], sessions);

  test("a working session reports its tool and 'since'", () => {
    expect(activity.get("work")).toMatchObject({ working: true, tool: "Bash", since: 2000, tier: null });
  });
  test("an awaiting-approval session reports the 'input' tier + approval kind", () => {
    expect(activity.get("appr")).toMatchObject({ working: false, tier: "input", approvalKind: "edit" });
  });
  test("an idle/completed session produces NO entry (label stays hidden)", () => {
    expect(activity.has("idle")).toBe(false);
  });
});
