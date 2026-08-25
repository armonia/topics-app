/**
 * Il buco: un agente dispatchato che apre una domanda o un permesso A METÀ TURNO
 * lasciava la card su `working`. La board diceva «sto lavorando» sopra una
 * sessione ferma su una persona, e l'unico modo di accorgersene era aprire il
 * tab per caso.
 *
 * Questi test guardano il PONTE — i due bridge annunciano, e l'annuncio è
 * esattamente uno per sessione, non uno per pannello. Il consumo del chip sta
 * nel dispatcher (`task-dispatcher.test.ts`).
 *
 * @covers HOLD-02
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { onHumanHoldChange, resetHumanHoldListeners, type HumanHoldChange } from "./human-hold-events";
import { beginAsk, endAsk, cancelAsk } from "./ask-user-bridge";
import { beginPermission, endPermission, cancelPermission, cancelPermissionsForSession } from "./permission-bridge";
import { isHumanHold } from "./human-hold";

let seen: HumanHoldChange[] = [];
let off: (() => void) | null = null;

beforeEach(() => {
  resetHumanHoldListeners();
  seen = [];
  off = onHumanHoldChange((c) => seen.push(c));
});
afterEach(() => {
  off?.();
  resetHumanHoldListeners();
});

describe("una domanda annuncia l'attesa", () => {
  test("beginAsk → held, endAsk → released", () => {
    const sk = "sess-ask-1";
    beginAsk(sk);
    expect(seen).toEqual([{ sessionKey: sk, phase: "held", source: "ask" }]);
    expect(isHumanHold(sk)).toBe(true);

    endAsk(sk);
    expect(seen.at(-1)).toEqual({ sessionKey: sk, phase: "released", source: "ask" });
    expect(isHumanHold(sk)).toBe(false);
  });

  test("endAsk su una sessione che non aspettava nessuno NON annuncia", () => {
    // Un `released` a vuoto rimetterebbe il chip a «in corso» su un task che
    // non ha mai smesso di esserlo: peggio di non annunciare.
    endAsk("sess-mai-aperta");
    expect(seen).toEqual([]);
  });

  test("cancelAsk (turno interrotto) annuncia il rilascio", () => {
    const sk = "sess-ask-2";
    beginAsk(sk);
    seen = [];
    cancelAsk(sk, "turno interrotto");
    expect(seen).toEqual([{ sessionKey: sk, phase: "released", source: "ask" }]);
  });
});

describe("un permesso annuncia per SESSIONE, non per pannello", () => {
  test("due permessi aperti insieme: un solo held, e released solo all'ultimo", () => {
    // La CLI emette più tool_use nello stesso messaggio (misurati a 170 ms):
    // tre pannelli non sono tre attese, e chiuderne uno non rimette il turno a
    // lavorare.
    const sk = "sess-perm-1";
    beginPermission(sk, "tool-a");
    beginPermission(sk, "tool-b");
    expect(seen.filter((c) => c.phase === "held")).toHaveLength(1);

    endPermission(sk, "tool-a");
    expect(seen.filter((c) => c.phase === "released")).toHaveLength(0);

    endPermission(sk, "tool-b");
    expect(seen.filter((c) => c.phase === "released")).toHaveLength(1);
    expect(seen.at(-1)?.source).toBe("permission");
  });

  test("cancelPermissionsForSession annuncia una volta sola, e solo se c'era qualcosa", () => {
    const sk = "sess-perm-2";
    cancelPermissionsForSession(sk, "niente da annullare");
    expect(seen).toEqual([]);

    beginPermission(sk, "tool-a");
    beginPermission(sk, "tool-b");
    seen = [];
    cancelPermissionsForSession(sk, "turno finito");
    expect(seen).toEqual([{ sessionKey: sk, phase: "released", source: "permission" }]);
  });

  test("cancelPermission (richiesta SCADUTA) annuncia il rilascio", () => {
    // La terza uscita, e la piu' facile da dimenticare: scatta quando il TTL
    // di 2h e' passato (topics.ts: `if (!beginPermission(...)) cancelPermission(...)`).
    // Senza annuncio la card resterebbe su «aspetta te» mentre l'agente ha gia'
    // ripreso — e la pulizia di fine turno non rimedia, perche' legge lo stato
    // DOPO che questa ha gia' tolto la voce.
    const sk = "sess-perm-3";
    beginPermission(sk, "tool-a");
    seen = [];
    cancelPermission(sk, "tool-a", "nessuna risposta: la richiesta è scaduta");
    expect(seen).toEqual([{ sessionKey: sk, phase: "released", source: "permission" }]);
  });

  test("con due pannelli aperti, cancelPermission su uno solo NON annuncia", () => {
    const sk = "sess-perm-4";
    beginPermission(sk, "tool-a");
    beginPermission(sk, "tool-b");
    seen = [];
    cancelPermission(sk, "tool-a");
    expect(seen).toEqual([]);
    cancelPermission(sk, "tool-b");
    expect(seen).toEqual([{ sessionKey: sk, phase: "released", source: "permission" }]);
  });
});

describe("l'annuncio non può rompere chi lo emette", () => {
  test("un ascoltatore che lancia non impedisce l'apertura del pannello", () => {
    // Il pannello dell'utente vale più della notifica: se aggiornare un chip
    // potesse far fallire `beginAsk`, la rete di sicurezza diventerebbe il
    // guasto.
    resetHumanHoldListeners();
    onHumanHoldChange(() => { throw new Error("ascoltatore rotto"); });
    const sk = "sess-ask-3";
    expect(() => beginAsk(sk)).not.toThrow();
    expect(isHumanHold(sk)).toBe(true);
    endAsk(sk);
  });
});
