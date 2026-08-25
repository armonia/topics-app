/**
 * @covers HOLD-01
 */
import { describe, expect, it } from "bun:test";
import { beginAsk, endAsk } from "./ask-user-bridge";
import { beginPermission, cancelPermissionsForSession, sessionHasPendingPermission, PERMISSION_TTL_MS } from "./permission-bridge";
import { humanHoldAgeMs, isHumanHold, releaseHumanHold } from "./human-hold";

const SK = "topic:test-hold";

function clean() {
  endAsk(SK);
  cancelPermissionsForSession(SK, "cleanup");
}

describe("isHumanHold — le due sorgenti sono lo stesso fatto per chi guarda da fuori", () => {
  it("falso quando non si aspetta nessuno", () => {
    clean();
    expect(isHumanHold(SK)).toBe(false);
  });

  it("vero con una DOMANDA aperta", () => {
    clean();
    beginAsk(SK);
    expect(isHumanHold(SK)).toBe(true);
    clean();
  });

  it("vero con un PERMESSO aperto — è il ramo che, mancando, fa uccidere un turno sotto un pannello", () => {
    clean();
    beginPermission(SK, "toolu_x");
    expect(isHumanHold(SK)).toBe(true);
    clean();
  });
});

describe("humanHoldAgeMs — si misura sull'attesa più LUNGA", () => {
  it("una richiesta appena aperta non rimette a zero l'orologio di una vecchia", () => {
    clean();
    const t0 = 5_000_000;
    beginAsk(SK, 60_000, t0);
    beginPermission(SK, "toolu_x", 60_000, t0 + 30_000);
    // Se prendesse il minimo, l'esenzione si riarmerebbe da sola all'infinito.
    expect(humanHoldAgeMs(SK, t0 + 40_000)).toBe(40_000);
    clean();
  });

  it("con una sola sorgente torna quella", () => {
    clean();
    const t0 = 5_000_000;
    beginPermission(SK, "toolu_x", 60_000, t0);
    expect(humanHoldAgeMs(SK, t0 + 1_500)).toBe(1_500);
    clean();
  });

  it("null quando non si aspetta nessuno", () => {
    clean();
    expect(humanHoldAgeMs(SK)).toBeNull();
  });
});

describe("releaseHumanHold", () => {
  it("chiude ENTRAMBE — mezza porta chiusa lascia un bridge a pollare a vuoto", () => {
    clean();
    beginAsk(SK);
    beginPermission(SK, "toolu_x");
    releaseHumanHold(SK, "turno interrotto");
    expect(isHumanHold(SK)).toBe(false);
    expect(sessionHasPendingPermission(SK)).toBe(false);
  });
});

describe("il permesso smette di essere un'attesa dopo il suo TTL", () => {
  /**
   * IL FANTASMA DEL 7 AGOSTO. Le richieste vivono in memoria e si chiudono solo
   * quando il bridge torna a pollare. Se il figlio CLI muore SOTTO un pannello
   * aperto non arriva più nessuna gamba, niente scade, e questo predicato —
   * che disarma watchdog, reaper e tetto di vita — giurerebbe per sempre che
   * una persona sta per rispondere su una sessione dove non c'è più nessuno.
   */
  it("entro il TTL è un'attesa vera", () => {
    clean();
    const t0 = 9_000_000;
    beginPermission(SK, "toolu_x", PERMISSION_TTL_MS, t0);
    expect(isHumanHold(SK, t0 + 60_000)).toBe(true);
    expect(humanHoldAgeMs(SK, t0 + 60_000)).toBe(60_000);
    clean();
  });

  it("oltre il TTL le reti di sicurezza tornano ad avere i denti", () => {
    clean();
    const t0 = 9_000_000;
    beginPermission(SK, "toolu_x", PERMISSION_TTL_MS, t0);
    expect(isHumanHold(SK, t0 + PERMISSION_TTL_MS + 1)).toBe(false);
    expect(humanHoldAgeMs(SK, t0 + PERMISSION_TTL_MS + 1)).toBeNull();
    clean();
  });

  it("ma una DOMANDA resta senza scadenza: chi risponde la mattina dopo la ritrova", () => {
    // Le due attese non hanno la stessa forma di morte, quindi non hanno lo
    // stesso tetto. Vedi la nota in testa a isHumanHold.
    clean();
    const t0 = 9_000_000;
    beginAsk(SK, 24 * 60 * 60 * 1000, t0);
    expect(isHumanHold(SK, t0 + PERMISSION_TTL_MS * 3)).toBe(true);
    clean();
  });
});
