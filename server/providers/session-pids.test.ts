/**
 * `listSessionCliPids` — le CHAT devono essere attribuibili quanto i terminali.
 *
 * Il registro dei pid esisteva gia' (serviva ad ancorare le shell in background)
 * ma non era scorribile, quindi l'attribuzione delle risorse copriva le sole
 * sessioni PTY: su una macchina dove si lavora in chat il tooltip diceva sempre
 * «non misurato» pur essendoci un albero di processi da contare.
 * @covers RES-ATTR-01
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { setSessionCliPid, clearSessionCliPid, listSessionCliPids, getSessionCliPid } from "./session-pids";

describe("listSessionCliPids", () => {
  beforeEach(() => { for (const { sessionKey } of listSessionCliPids()) clearSessionCliPid(sessionKey); });

  it("elenca le sessioni chat con un CLI vivo", () => {
    setSessionCliPid("chat-a", 111);
    setSessionCliPid("chat-b", 222);
    const out = listSessionCliPids().sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
    expect(out).toEqual([{ sessionKey: "chat-a", pid: 111 }, { sessionKey: "chat-b", pid: 222 }]);
  });

  it("una sessione dimenticata sparisce dall'elenco", () => {
    setSessionCliPid("chat-a", 111);
    setSessionCliPid("chat-a", null);
    expect(listSessionCliPids()).toEqual([]);
    expect(getSessionCliPid("chat-a")).toBeNull();
  });

  it("un pid non valido non entra", () => {
    setSessionCliPid("chat-x", 0);
    setSessionCliPid("chat-y", -1);
    expect(listSessionCliPids()).toEqual([]);
  });
});
