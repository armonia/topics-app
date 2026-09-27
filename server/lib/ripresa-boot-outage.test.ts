/**
 * The resume against cuts that came from outside the turn: an API that
 * stopped answering (card e30f35e4) and the ai-bridge daemon dying under its
 * children (card 51fb9359). Split from `ripresa-boot.test.ts`, which holds the
 * rest of the rule and the sweep against a database.
 *
 * @covers RESUME-01, RESUME-04
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resumeCapNotice, resumeVerdict, riprendiTurniInterrotti } from "./ripresa-boot";
import { INTERRUPTED_MARKER } from "./stale-stream-sweep";
import { avvisoPerTurno } from "./cancelled-notice";
import { clearProviderHold, setProviderHold } from "./provider-hold";
import { cancelled } from "../providers/stop-reason";
import type { ContentBlock } from "../types";

type Row = Parameters<typeof resumeVerdict>[0];

const NOW = Date.UTC(2026, 8, 25, 3, 0, 0);
const prose: ContentBlock = { kind: "text", text: "stavo misurando" };
const base: Row = {
  sessionKey: "topic:3019832f",
  ruolo: "assistant",
  blocks: null,
  timestampMs: NOW - 60_000,
  attempts: 0,
};

/**
 * Cuts that came from outside the turn. Topic 3019832f on 25/09: the API went
 * dark at 02:00Z, the claude-code watchdog closed the turn at 02:30Z with a
 * bare text and no cause, and every sweep from 02:35 to 03:20 read it as
 * "no" until a person resent by hand, 52 minutes later. And the same day at
 * 12:57 the ai-bridge daemon died under four live CLIs, whose turns ended
 * "as died" and stayed there.
 */
describe("an outage outside the turn is resumed", () => {
  const tool: ContentBlock = { kind: "tool", toolCall: { id: "toolu_1", name: "Bash", args: {}, status: "success" } } as ContentBlock;

  test("the watchdog's bare text on the real row (5e92d06e) is a cut of ours", () => {
    const row: Row = {
      ...base,
      blocks: [tool, tool, { kind: "error", text: "Nessuna attività dal modello per 30 minuti. Turno terminato." } as ContentBlock],
    };
    expect(resumeVerdict(row, NOW)).toBe("resend");
  });

  test("a turn the API left unanswered, and one whose daemon died, are resent", () => {
    for (const cause of ["api-unavailable", "broker-died"]) {
      const cut = { kind: "error", text: "una frase qualunque", cause } as unknown as ContentBlock;
      expect(resumeVerdict({ ...base, blocks: [prose, cut] }, NOW), cause).toBe("resend");
    }
  });

  /**
   * A wake (a background task or a Monitor delivering) opens a row of its own
   * under a person's message that was already answered, and the resend is that
   * message. A wake cut by an outage is left alone: resent, the agent ran the
   * message a second time (the blackout of 25/09 met a wake on 4e5e2d76,
   * fb360b27), and on the base those rows were never resumable. A wake cut by a
   * stall of ours, the watchdog's or the stale sweeper's, keeps the base's
   * resend: its notice has promised it since before these cards.
   */
  test("a woken turn cut by an outage is not resent; one cut by a stall still is", () => {
    const wake = { kind: "woken", label: "bjppuaycc" } as ContentBlock;
    const cuts: Array<[string, string, string]> = [
      ["api-unavailable", "una frase qualunque", "no"],
      ["broker-died", "una frase qualunque", "no"],
      ["watchdog", avvisoPerTurno(cancelled("watchdog"), { haProdotto: true, riprendeDaSolo: true })!.replace(/^⚠️\s*/, ""), "resend"],
      ["watchdog", INTERRUPTED_MARKER.replace(/^⚠️\s*/, ""), "resend"],
    ];
    for (const [cause, text, verdict] of cuts) {
      const cut = { kind: "error", text, cause } as unknown as ContentBlock;
      expect(resumeVerdict({ ...base, blocks: [wake, { kind: "text", text: "Request timed out" }, cut] }, NOW), `${cause}: ${text}`).toBe(verdict as never);
    }
  });

  test("a child that died on its own, with the daemon alive, stays where it is", () => {
    const died = { kind: "error", text: "Process died unexpectedly", cause: "process-died" } as ContentBlock;
    expect(resumeVerdict({ ...base, blocks: [prose, died] }, NOW)).toBe("no");
  });

  test("the cap notice names the outage that cut the last link, not an unknown cause", () => {
    expect(resumeCapNotice({ restarted: false, cause: "api-unavailable" })).toMatch(/l'API non rispondeva/);
    expect(resumeCapNotice({ restarted: false, cause: "broker-died" })).toMatch(/ospitava l'agente/);
  });
});

/**
 * A HOLD WALLS ITS OWN PROVIDER'S CHATS, not the sweep. Only claude-code
 * survives a reload (`providerSurvivesRestart`), so a Codex chat in flight is
 * cut `server-shutdown` at every save under server/, under a notice promising
 * it resumes by itself; with a Claude hold in force the boot's sweep is the
 * only one that runs (server.ts holds the periodic one and the nudge). A
 * Claude hold of days (a spent weekly window) deferring the whole boot sweep
 * left that chat stopped past the 24-hour window, for good.
 */
describe("the boot sweep under a Claude hold", () => {
  const RESTART = "Turno interrotto: il server si è riavviato mentre la risposta era in corso. Riprendo da solo: non serve che tu faccia niente.";

  function cutByReload(db: Database, sk: string): void {
    const now = new Date().toISOString();
    db.run("INSERT INTO messages VALUES (?, ?, 'user', 'fai la cosa', NULL, 0, ?, 0, NULL, 0)", [`u-${sk}`, sk, now]);
    const blocks = [prose, { kind: "error", text: RESTART, cause: "server-shutdown" }];
    db.run("INSERT INTO messages VALUES (?, ?, 'assistant', '', ?, 0, ?, 1, ?, 0)", [`a-${sk}`, sk, JSON.stringify(blocks), now, `u-${sk}`]);
  }

  test("resends a Codex chat cut by the reload and keeps a Claude one, a pinned one or one on the default, waiting", async () => {
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, blocks TEXT,
      partial INTEGER, timestamp TEXT, sort_order INTEGER, parent_id TEXT, branch_index INTEGER)`);
    const providers: Record<string, string | null> = { "topic:codex": "codex", "topic:claude": "claude-code", "topic:default": null };
    for (const sk of Object.keys(providers)) cutByReload(db, sk);
    const resent: string[] = [];
    const route = async (req: Request) => {
      resent.push(String((await req.json() as { sessionKey?: unknown }).sessionKey));
      return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
    };
    setProviderHold({ untilMs: Date.now() + 3 * 86_400_000, window: "seven_day", reason: "finestra settimanale del piano esaurita" });
    const log = console.log;
    console.log = () => {};
    try {
      await riprendiTurniInterrotti({
        db, bootedAtMs: Date.now(), defaultProvider: () => "claude-code",
        getTopicBySessionKey: (sk) => ({ id: sk.slice(6), archived: false, provider: providers[sk] }),
      }, route as never, { responseMs: 500, streamMs: 500 });
    } finally {
      console.log = log;
      clearProviderHold();
    }
    expect(resent).toEqual(["topic:codex"]);
  });
});
