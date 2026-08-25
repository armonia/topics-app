/**
 * «Passa a libero», la parte pura: chi è libero, e cosa succede quando lo
 * diventa.
 *
 * Le due regressioni che sorveglia:
 *   - un livello VUOTO o storto letto come «non chiede» — cioè un sì automatico
 *     regalato da un typo. `permissionModeForAutonomy` ripiega di proposito sul
 *     default (`bypassPermissions`) perché allo spawn un livello sbagliato non
 *     deve poter bloccare una chat; qui la stessa regola, presa così com'è,
 *     aprirebbe la porta invece di chiuderla;
 *   - una sessione liberata SENZA che il selettore di autonomia se ne accorga:
 *     il `topic:updated` è l'unico modo in cui l'unico comando da cui si torna
 *     indietro viene a saperlo.
 *
 * @covers EXTSESS-06
 */
import { describe, expect, test } from "bun:test";
import type { Topic } from "../../shared/types";
import { FREE_AUTONOMY_LEVEL, sessionIsFree, switchSessionToFree } from "./session-free-mode";

function fakeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: "t1",
    name: "chat",
    slug: "chat",
    parentId: null,
    links: [],
    sessionKey: "sk:1",
    color: "#fff",
    icon: "message",
    createdAt: "2026-08-11T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:00.000Z",
    archived: false,
    autonomyLevel: "auto-apply",
    ...overrides,
  } as Topic;
}

function harness(topics: Topic[]) {
  const saved: Topic[] = [];
  const frames: { type: string; topic: Topic }[] = [];
  const ctx = {
    getTopicBySessionKey: (sk: string) => topics.find((t) => t.sessionKey === sk) ?? null,
    saveSingleTopic: (t: Topic) => { saved.push({ ...t }); },
    broadcastToAll: (m: { type: "topic:updated"; topic: Topic }) => { frames.push({ ...m }); },
  };
  return { ctx, saved, frames };
}

describe("sessionIsFree — nel dubbio si CHIEDE", () => {
  test("libera è solo la chat che ha scelto «nessun freno»", () => {
    expect(sessionIsFree("yolo")).toBe(true);
    expect(FREE_AUTONOMY_LEVEL).toBe("yolo");
  });

  test("«agisce» e «propone prima» continuano a chiedere", () => {
    expect(sessionIsFree("auto-apply")).toBe(false);
    expect(sessionIsFree("ask")).toBe(false);
  });

  test("un livello assente, vuoto o storto NON è libero", () => {
    // Il caso che conta: `permissionModeForAutonomy('yoIo')` torna
    // `bypassPermissions` (il default), quindi chiedere alla sola tabella
    // «questa modalità chiede?» direbbe di no — e un permesso verrebbe
    // concesso da solo per un carattere sbagliato.
    expect(sessionIsFree("yoIo")).toBe(false);
    expect(sessionIsFree("bypassPermissions")).toBe(false);
    expect(sessionIsFree("")).toBe(false);
    expect(sessionIsFree(null)).toBe(false);
    expect(sessionIsFree(undefined)).toBe(false);
  });
});

describe("switchSessionToFree", () => {
  test("scrive il livello sul topic, lo salva e lo ANNUNCIA", () => {
    const topic = fakeTopic();
    const h = harness([topic]);
    const change = switchSessionToFree(h.ctx, "sk:1")!;

    expect(change.changed).toBe(true);
    expect(change.previous).toBe("auto-apply");
    expect(topic.autonomyLevel).toBe("yolo");
    expect(h.saved).toHaveLength(1);
    // Senza il frame, il selettore nel composer continuerebbe a dire «Agisce»
    // su una chat che non chiede più: il comando da cui si torna indietro
    // mostrerebbe il regime sbagliato.
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0].type).toBe("topic:updated");
    expect(h.frames[0].topic.autonomyLevel).toBe("yolo");
  });

  test("tocca SOLO la sessione che ha premuto", () => {
    const mia = fakeTopic({ id: "t1", sessionKey: "sk:1" });
    const altra = fakeTopic({ id: "t2", sessionKey: "sk:2", autonomyLevel: "auto-apply" });
    const h = harness([mia, altra]);

    switchSessionToFree(h.ctx, "sk:1");

    expect(altra.autonomyLevel).toBe("auto-apply");
    expect(h.saved.map((t) => t.id)).toEqual(["t1"]);
  });

  test("già libera: idempotente, e non finge un cambio che non c'è stato", () => {
    const topic = fakeTopic({ autonomyLevel: "yolo" });
    const h = harness([topic]);
    const change = switchSessionToFree(h.ctx, "sk:1")!;

    expect(change.changed).toBe(false);
    expect(h.saved).toHaveLength(0);
    expect(h.frames).toHaveLength(0);
  });

  test("sessione senza topic: `null`, non un «fatto» a vuoto", () => {
    const h = harness([]);
    expect(switchSessionToFree(h.ctx, "sk:ignota")).toBeNull();
  });
});
