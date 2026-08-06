import { describe, it, expect } from "bun:test";
import { readFastMode, fastModeAvailable, sameFastMode, fastModeCommand } from "./fast-mode";

/**
 * Gli eventi qui sotto sono COPIATI da una run vera della CLI 2.1.223
 * (`claude -p "/fast on" --output-format stream-json`), non inventati: è la
 * forma che dobbiamo saper leggere.
 */
describe("readFastMode", () => {
  it("legge init e result, che portano gli stessi due campi", () => {
    const init = { type: "system", subtype: "init", fast_mode_state: "off", fast_mode_disabled_reason: "sdk_opt_in_required" };
    expect(readFastMode(init)).toEqual({ state: "off", reason: "sdk_opt_in_required" });
    const result = { type: "result", subtype: "success", fast_mode_state: "off", fast_mode_disabled_reason: "sdk_opt_in_required" };
    expect(readFastMode(result)).toEqual({ state: "off", reason: "sdk_opt_in_required" });
  });

  it("motivo ASSENTE = niente la blocca (non è un errore)", () => {
    expect(readFastMode({ fast_mode_state: "on" })).toEqual({ state: "on", reason: null });
    expect(readFastMode({ fast_mode_state: "off" })).toEqual({ state: "off", reason: null });
    expect(readFastMode({ fast_mode_state: "cooldown" })).toEqual({ state: "cooldown", reason: null });
  });

  it("un evento che non ne parla dà null — «non lo so», non «spenta»", () => {
    expect(readFastMode({ type: "assistant" })).toBeNull();
    expect(readFastMode(null)).toBeNull();
    expect(readFastMode("stringa")).toBeNull();
  });

  it("valori fuori enum non passano: il client non deve indovinarli", () => {
    expect(readFastMode({ fast_mode_state: "turbo" })).toBeNull();
    expect(readFastMode({ fast_mode_state: "on", fast_mode_disabled_reason: "motivo-nuovo" }))
      .toEqual({ state: "on", reason: null });
  });
});

describe("fastModeAvailable", () => {
  it("il motivo è il criterio: assente = si può", () => {
    expect(fastModeAvailable({ state: "off", reason: null })).toBe(true);
    expect(fastModeAvailable({ state: "on", reason: null })).toBe(true);
    expect(fastModeAvailable({ state: "cooldown", reason: null })).toBe(true);
    expect(fastModeAvailable({ state: "off", reason: "sdk_opt_in_required" })).toBe(false);
    expect(fastModeAvailable({ state: "off", reason: "model_not_allowed" })).toBe(false);
  });

  it("non saperlo NON è indisponibile: il bottone resta vivo", () => {
    expect(fastModeAvailable(null)).toBe(true);
    expect(fastModeAvailable(undefined)).toBe(true);
  });
});

describe("fastModeCommand", () => {
  it("manda il comando solo se serve, e sempre esplicito", () => {
    expect(fastModeCommand({ state: "off", reason: null }, true)).toBe("/fast on");
    expect(fastModeCommand({ state: "on", reason: null }, false)).toBe("/fast off");
    // `cooldown` è accesa, in pausa: chiederle «on» sarebbe rumore.
    expect(fastModeCommand({ state: "cooldown", reason: null }, true)).toBeNull();
    expect(fastModeCommand({ state: "on", reason: null }, true)).toBeNull();
    expect(fastModeCommand({ state: "off", reason: null }, false)).toBeNull();
  });

  it("se è bloccata non le si parla: il rifiuto finirebbe nella chat", () => {
    // La CLI risponde con un messaggio di testo («Fast mode unavailable: …»),
    // che comparirebbe come turno dell'assistente.
    expect(fastModeCommand({ state: "off", reason: "sdk_opt_in_required" }, true)).toBeNull();
  });

  it("finché non ha parlato lei, niente comandi al buio", () => {
    expect(fastModeCommand(null, true)).toBeNull();
  });
});

describe("sameFastMode", () => {
  it("distingue i cambi veri dai ri-annunci identici", () => {
    expect(sameFastMode({ state: "off", reason: "pending" }, { state: "off", reason: "pending" })).toBe(true);
    expect(sameFastMode({ state: "off", reason: "pending" }, { state: "off", reason: null })).toBe(false);
    expect(sameFastMode({ state: "off", reason: null }, { state: "on", reason: null })).toBe(false);
    expect(sameFastMode(null, null)).toBe(true);
    expect(sameFastMode(null, { state: "on", reason: null })).toBe(false);
  });
});
