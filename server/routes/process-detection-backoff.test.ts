/**
 * Backoff della rilevazione dei processi.
 *
 * Il ciclo esce gratis quando non c'è nessuna sessione Claude eleggibile, ma con
 * una sessione aperta — il caso normale di questa app — ogni passata fa `lsof`
 * sulle porte in ascolto, un secondo `lsof` per i cwd e una tabella dei
 * processi. A cadenza fissa di 4s sono ~43.000 spawn al giorno per riscoprire lo
 * stesso elenco, anche con nessuno che guarda il pannello.
  * @covers PROCESS-10
 */

import { describe, expect, test } from "bun:test";
import {
  DETECTION_INTERVAL_MS,
  DETECTION_INTERVAL_MAX_MS,
  nextDetectionDelay,
  processDetectionViewIsOpen,
  bumpProcessDetection,
  stopProcessDetectionForTests,
  ghostCwdProbeDue,
  GHOST_CWD_PROBE_MIN_INTERVAL_MS,
} from "./processes";

describe("nextDetectionDelay", () => {
  test("un cambiamento riporta SEMPRE alla cadenza piena", () => {
    expect(nextDetectionDelay(DETECTION_INTERVAL_MAX_MS, true)).toBe(DETECTION_INTERVAL_MS);
    expect(nextDetectionDelay(DETECTION_INTERVAL_MS, true)).toBe(DETECTION_INTERVAL_MS);
  });

  test("senza cambiamenti raddoppia, ma si ferma al tetto", () => {
    let d = DETECTION_INTERVAL_MS;
    const seen = [d];
    for (let i = 0; i < 8; i++) {
      d = nextDetectionDelay(d, false);
      seen.push(d);
    }
    expect(seen.slice(0, 4)).toEqual([4000, 8000, 16000, 32000]);
    expect(Math.max(...seen)).toBe(DETECTION_INTERVAL_MAX_MS);
  });

  test("a riposo il costo scende di ~87%: 15 passate al minuto → 1,875", () => {
    // Il numero che giustifica la modifica, non un'impressione.
    const before = 60_000 / DETECTION_INTERVAL_MS;
    const after = 60_000 / DETECTION_INTERVAL_MAX_MS;
    expect(before).toBe(15);
    expect(after).toBeCloseTo(1.875, 3);
    expect(1 - after / before).toBeCloseTo(0.875, 3);
  });
});

describe("process detection demand", () => {
  test("the periodic port scan stays off until the process view is requested", () => {
    stopProcessDetectionForTests();
    expect(processDetectionViewIsOpen(Date.now())).toBe(false);
    bumpProcessDetection();
    expect(processDetectionViewIsOpen(Date.now())).toBe(true);
    expect(processDetectionViewIsOpen(Date.now() + 15_001)).toBe(false);
    stopProcessDetectionForTests();
  });

});

describe("ghost cwd probe cadence", () => {
  test("limits lsof checks to at most 30 per hour when ghost candidates persist", () => {
    expect(GHOST_CWD_PROBE_MIN_INTERVAL_MS).toBe(120_000);
    expect(ghostCwdProbeDue(119_999, 0)).toBe(false);
    expect(ghostCwdProbeDue(120_000, 0)).toBe(true);
    expect(60 * 60_000 / GHOST_CWD_PROBE_MIN_INTERVAL_MS).toBe(30);
  });
});
