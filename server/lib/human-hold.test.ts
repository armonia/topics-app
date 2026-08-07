import { describe, expect, it } from "bun:test";
import { beginAsk, endAsk } from "./ask-user-bridge";
import { beginPermission, cancelPermissionsForSession, sessionHasPendingPermission } from "./permission-bridge";
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
