/**
 * inline-sent-state — la memoria di cosa la sessione CLI possiede già.
 *
 * I casi che contano non sono "ricorda": sono i due in cui DEVE dimenticare
 * (sessione nuova, compattazione) e quello in cui deve disfare (invio fallito).
 * Sbagliare per eccesso costa ~2k token una volta; sbagliare per difetto lascia
 * un modello che non sa in che progetto si trova.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  __clearInlineSentStateForTests,
  getInlineSentState,
  hashSlot,
  inlineScope,
  markInlineSent,
  resetInlineSent,
} from "./inline-sent-state";

const KEY = "topic:abc";

beforeEach(() => __clearInlineSentStateForTests());

describe("hashSlot", () => {
  test("stesso contenuto → stesso hash, contenuto diverso → hash diverso", () => {
    expect(hashSlot("ciao")).toBe(hashSlot("ciao"));
    expect(hashSlot("ciao")).not.toBe(hashSlot("ciao "));
  });
});

describe("inlineScope", () => {
  test("cambia con la sessione CLI e con il numero di compattazioni", () => {
    expect(inlineScope("s1", 0)).toBe(inlineScope("s1", 0));
    expect(inlineScope("s1", 0)).not.toBe(inlineScope("s2", 0));
    expect(inlineScope("s1", 0)).not.toBe(inlineScope("s1", 1));
  });

  test("una sessione CLI ancora sconosciuta ha comunque uno scope stabile", () => {
    expect(inlineScope(null, 0)).toBe(inlineScope(undefined, 0));
  });
});

describe("getInlineSentState / markInlineSent", () => {
  test("uno slot marcato viene ritrovato con il suo hash", () => {
    const scope = inlineScope("s1", 0);
    markInlineSent(KEY, scope, [{ slot: "template", hash: "aaa" }]);
    expect(getInlineSentState(KEY, scope).get("template")).toBe("aaa");
  });

  test("una sessione mai vista è vuota", () => {
    expect(getInlineSentState("topic:mai-visto", inlineScope("s1", 0)).size).toBe(0);
  });

  test("il mark SOSTITUISCE lo stato: uno slot assente dalla lista esce", () => {
    const scope = inlineScope("s1", 0);
    markInlineSent(KEY, scope, [
      { slot: "template", hash: "aaa" },
      { slot: "plan-mode", hash: "bbb" },
    ]);
    markInlineSent(KEY, scope, [{ slot: "template", hash: "aaa" }]);
    const state = getInlineSentState(KEY, scope);
    expect(state.get("template")).toBe("aaa");
    expect(state.has("plan-mode")).toBe(false);
  });

  test("una sessione CLI nuova azzera tutto", () => {
    markInlineSent(KEY, inlineScope("s1", 0), [{ slot: "template", hash: "aaa" }]);
    expect(getInlineSentState(KEY, inlineScope("s2", 0)).size).toBe(0);
  });

  test("una compattazione azzera tutto", () => {
    markInlineSent(KEY, inlineScope("s1", 0), [{ slot: "template", hash: "aaa" }]);
    expect(getInlineSentState(KEY, inlineScope("s1", 1)).size).toBe(0);
  });
});

describe("rollback", () => {
  test("un invio fallito riporta lo stato esattamente a com'era", () => {
    const scope = inlineScope("s1", 0);
    markInlineSent(KEY, scope, [{ slot: "template", hash: "aaa" }]);

    const undo = markInlineSent(KEY, scope, [
      { slot: "template", hash: "aaa" },
      { slot: "memory", hash: "ccc" },
    ]);
    expect(getInlineSentState(KEY, scope).size).toBe(2);

    undo();
    const state = getInlineSentState(KEY, scope);
    expect(state.size).toBe(1);
    expect(state.get("template")).toBe("aaa");
  });

  test("il rollback del PRIMO turno riporta la sessione a sconosciuta", () => {
    const scope = inlineScope("s1", 0);
    const undo = markInlineSent(KEY, scope, [{ slot: "template", hash: "aaa" }]);
    undo();
    expect(getInlineSentState(KEY, scope).size).toBe(0);
  });

  test("il rollback non intacca le altre sessioni", () => {
    const scope = inlineScope("s1", 0);
    markInlineSent("topic:altro", scope, [{ slot: "template", hash: "zzz" }]);
    markInlineSent(KEY, scope, [{ slot: "template", hash: "aaa" }])();
    expect(getInlineSentState("topic:altro", scope).get("template")).toBe("zzz");
  });
});

describe("capienza e reset", () => {
  test("resetInlineSent dimentica una sessione", () => {
    const scope = inlineScope("s1", 0);
    markInlineSent(KEY, scope, [{ slot: "template", hash: "aaa" }]);
    resetInlineSent(KEY);
    expect(getInlineSentState(KEY, scope).size).toBe(0);
  });

  test("oltre il cap sfratta le vecchie ma tiene quella appena scritta", () => {
    const scope = inlineScope("s1", 0);
    for (let i = 0; i < 300; i++) {
      markInlineSent(`topic:${i}`, scope, [{ slot: "template", hash: `h${i}` }]);
    }
    // L'ultima c'è sempre; la prima è uscita.
    expect(getInlineSentState("topic:299", scope).get("template")).toBe("h299");
    expect(getInlineSentState("topic:0", scope).size).toBe(0);
  });
});
