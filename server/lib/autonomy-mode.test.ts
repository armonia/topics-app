/**
 * Due modi di sbagliare, e i test guardano quelli: dare più potere di quanto
 * l'utente ha chiesto (una chat «chiedi prima» che scrive sul disco), e
 * bloccare una chat che prima funzionava (un valore sconosciuto che diventa una
 * modalità che in `--print` resta appesa).
 */
import { describe, test, expect } from "bun:test";
import { permissionModeForAutonomy, describeAutonomy, DEFAULT_PERMISSION_MODE } from "./autonomy-mode";

describe("permissionModeForAutonomy", () => {
  test("i tre livelli mappano sulle modalità provate sul campo", () => {
    expect(permissionModeForAutonomy("ask")).toBe("plan");
    expect(permissionModeForAutonomy("auto-apply")).toBe("acceptEdits");
    expect(permissionModeForAutonomy("yolo")).toBe("bypassPermissions");
  });

  test("«chiedi prima» NON deve mai finire su una modalità che agisce", () => {
    // È l'errore che conta: un utente che sceglie «chiedi» e si ritrova file
    // modificati non ha ricevuto una funzione, ha ricevuto una bugia.
    expect(permissionModeForAutonomy("ask")).not.toBe("bypassPermissions");
    expect(permissionModeForAutonomy("ask")).not.toBe("acceptEdits");
  });

  test("nessun livello scelto: il comportamento di PRIMA, non uno nuovo", () => {
    // Cambiare il default avrebbe zittito le chat di chi non ha mai toccato
    // l'impostazione — una migrazione silenziosa travestita da funzione.
    expect(permissionModeForAutonomy(null)).toBe(DEFAULT_PERMISSION_MODE);
    expect(permissionModeForAutonomy(undefined)).toBe(DEFAULT_PERMISSION_MODE);
    expect(permissionModeForAutonomy("")).toBe(DEFAULT_PERMISSION_MODE);
  });

  test("un livello sconosciuto non blocca la chat", () => {
    // Un valore scritto male (o di una versione futura) deve degradare al
    // default, non su una modalità che in --print potrebbe restare appesa.
    expect(permissionModeForAutonomy("ASK")).toBe(DEFAULT_PERMISSION_MODE);
    expect(permissionModeForAutonomy("prudente")).toBe(DEFAULT_PERMISSION_MODE);
  });
});

describe("describeAutonomy", () => {
  test("ogni livello si spiega con cosa FA, non con il suo nome", () => {
    expect(describeAutonomy("ask")).toContain("non tocca file");
    expect(describeAutonomy("auto-apply")).toContain("modifiche ai file");
    expect(describeAutonomy("yolo")).toContain("senza chiedere");
  });

  test("anche «nessuna scelta» dice cosa succede", () => {
    expect(describeAutonomy(null)).toContain("nessun livello scelto");
  });
});
