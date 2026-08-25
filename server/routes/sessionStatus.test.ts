/**
 * `/status` answers the question that made someone type it.
 *
 * Nobody types `/status` out of curiosity. They type it because the last turn
 * did something they did not expect, and the report is only useful if it
 * contains the fact that explains the surprise. The old version named four
 * things — session key, message count, project path, topic name — and three of
 * those four are already on screen: the topic is in the tab, the project is in
 * the sidebar, and the session key is an internal identifier nobody asked
 * about. Everything that actually decides how the next turn behaves was
 * missing, from an object the handler already held.
 *
 * So these tests are written from the questions, not from the fields:
 *
 *   "why did it refuse to touch my files?"      → the autonomy line
 *   "why is it slower / less sharp than before?" → the model and effort lines
 *   "why can it not see my MCP servers?"         → the fleet line
 *
 * The one asymmetry worth stating: the model line names its SOURCE. "the topic
 * pins opus" and "nothing is pinned and the default is opus" look identical on
 * screen and are not the same fact — only the first survives a change of the
 * default, and telling them apart is exactly what someone debugging needs.
 *
 * @covers CMD-07
 */
import { describe, expect, test } from "bun:test";
import { sessionStatus, type TopicForStatus } from "./sessionStatus";

const base = (t: Partial<TopicForStatus> = {}) =>
  sessionStatus({ sessionKey: "topic:abc", messaggi: 7, topic: { name: "Rifattorizzare il dispatcher", ...t } });

describe("le domande a cui deve rispondere", () => {
  test("«perche' non ha toccato i file?» — l'autonomia dice il livello E cosa comporta", () => {
    const out = base({ autonomyLevel: "ask" });
    expect(out).toContain("ask");
    // The name alone does not answer: "ask" tells nobody that this chat runs
    // no commands. The consequence is written next to it.
    expect(out).toContain("non tocca file");
  });

  test("un livello sconosciuto lo dice, invece di far finta di conoscerlo", () => {
    // The branch that matters the day somebody adds a level and forgets this
    // table: better "unknown" than a mute line.
    expect(base({ autonomyLevel: "qualcosa-di-nuovo" })).toContain("livello sconosciuto");
  });

  test("«perche' e' piu' lento?» — modello, effort e fast mode compaiono", () => {
    const out = base({ model: "claude-opus-5", effort: "xhigh", fastMode: true });
    expect(out).toContain("claude-opus-5");
    expect(out).toContain("xhigh");
    expect(out).toContain("Fast mode");
  });

  test("«perche' non vede i miei server MCP?» — la flotta ridotta si dichiara", () => {
    expect(base({ mcpPolicy: "bridge-only" })).toContain("flotta ridotta");
    expect(base({ mcpPolicy: null }), "la flotta piena e' il default, e un default non e' una notizia")
      .not.toContain("flotta ridotta");
  });
});

describe("il modello dice DA DOVE viene", () => {
  test("fissato sul topic", () => {
    expect(base({ model: "claude-opus-5" })).toContain("fissato su questo topic");
  });

  test("non fissato: si nomina il ripiego e si dice che e' un default", () => {
    const out = sessionStatus({
      sessionKey: "topic:abc",
      messaggi: 0,
      topic: {},
      modelloDiRipiego: "claude-sonnet-5",
    });
    expect(out).toContain("claude-sonnet-5");
    expect(out).toContain("non fissato qui");
  });

  test("il topic vince sul ripiego, e il ripiego non compare due volte", () => {
    const out = sessionStatus({
      sessionKey: "topic:abc",
      messaggi: 0,
      topic: { model: "claude-opus-5" },
      modelloDiRipiego: "claude-sonnet-5",
    });
    expect(out).toContain("claude-opus-5");
    expect(out, "due rows «modello» sono due risposte a una domanda sola").not.toContain("claude-sonnet-5");
  });
});

describe("cosa NON si scrive", () => {
  test("un campo assente non produce una riga che dice «niente»", () => {
    // "Effort: none" teaches nothing and pushes the lines that matter further
    // down. An absent override IS the default, and a default is not news.
    const out = base();
    expect(out).not.toContain("Effort");
    expect(out).not.toContain("Fast mode");
    expect(out).not.toContain("Worktree");
    expect(out).not.toContain("File di contesto");
  });

  test("zero file di contesto non e' una riga", () => {
    expect(base({ contextFiles: [] })).not.toContain("File di contesto");
    expect(base({ contextFiles: ["a.ts", "b.ts"] })).toContain("2");
  });

  test("`fastMode: false` non e' «fast mode spento», e' silenzio", () => {
    expect(base({ fastMode: false })).not.toContain("Fast mode");
  });
});

describe("l'ordine, e il caso senza topic", () => {
  test("l'identificatore interno sta in fondo", () => {
    // It is copied into a bug report; it is not what anyone came to read.
    const rows = base({ model: "claude-opus-5" }).split("\n");
    expect(rows.at(-1)).toContain("topic:abc");
    expect(rows[0], "quello che si legge per primo e' il nome della chat").toContain("Rifattorizzare");
  });

  test("senza topic risponde lo stesso, invece di rompersi", () => {
    // A session the registry does not know (adopted, or just created) must not
    // fail the command: the two facts we do have are enough.
    const out = sessionStatus({ sessionKey: "topic:orfano", messaggi: 3, topic: null });
    expect(out).toContain("topic:orfano");
    expect(out).toContain("3");
  });
});
