/**
 * The "by resources" brake: load -> start/wait, and the colours of the threshold.
 *
 * Proved HERE and not against the real machine for the same reason the memory
 * floor has an injectable probe: the only case that matters is a saturated
 * machine, and proving it for real would mean saturating the machine somebody
 * is working on. The function is pure, the caller passes the measurement.
 *
 * @covers KANBAN-75
 */
import { describe, expect, it } from "bun:test";
import {
  LOAD_RATIO_DEFAULT,
  LOAD_RATIO_MAX,
  MEM_RATIO_DEFAULT,
  capMode,
  capThresholds,
  livePressureBand,
  loadThresholdBand,
  machinePressureVerdict,
  memThresholdBand,
} from "./board";

const thresholds = { maxLoadRatio: LOAD_RATIO_DEFAULT, maxMemRatio: MEM_RATIO_DEFAULT };
const machine = (over: Partial<Parameters<typeof machinePressureVerdict>[0]> = {}) => ({
  load1: 2,
  cores: 10,
  availableMemGB: 16,
  totalMemGB: 32,
  running: 1,
  ...over,
});

describe("machinePressureVerdict — la macchina decide, e dice quale asse", () => {
  it("ammette con carico e memoria sotto soglia", () => {
    const v = machinePressureVerdict(machine(), thresholds);
    expect(v.admit).toBe(true);
    expect(v.blockedBy).toBe(null);
    expect(v.loadRatio).toBeCloseTo(0.2, 5);
    expect(v.memRatio).toBeCloseTo(0.5, 5);
  });

  it("aspetta quando il carico è sopra la soglia", () => {
    const v = machinePressureVerdict(machine({ load1: 11 }), thresholds);
    expect(v.admit).toBe(false);
    expect(v.blockedBy).toBe("load");
  });

  it("aspetta quando la memoria è sopra la soglia, anche col carico basso", () => {
    const v = machinePressureVerdict(machine({ availableMemGB: 2 }), thresholds);
    expect(v.admit).toBe(false);
    expect(v.blockedBy).toBe("memory");
  });

  it("il carico parla per primo: due assi rossi restano UNA riga", () => {
    const v = machinePressureVerdict(machine({ load1: 11, availableMemGB: 1 }), thresholds);
    expect(v.blockedBy).toBe("load");
  });

  it("la soglia morde ESATTAMENTE sul suo valore", () => {
    // 9/10 = 0.9 = the threshold: the boundary is INCLUSIVE, written down once
    // here because it is the bug class its twin `contextLevel` already paid for.
    expect(machinePressureVerdict(machine({ load1: 9 }), thresholds).admit).toBe(false);
    expect(machinePressureVerdict(machine({ load1: 8.9 }), thresholds).admit).toBe(true);
  });

  it("senza sonda della memoria il verdetto resta sul solo carico", () => {
    const v = machinePressureVerdict(machine({ availableMemGB: null, load1: 1 }), thresholds);
    expect(v.memRatio).toBe(null);
    expect(v.admit).toBe(true);
  });

  it("con zero agenti vivi il primo parte comunque, e lo dichiara", () => {
    const v = machinePressureVerdict(machine({ load1: 40, running: 0 }), thresholds);
    expect(v.admit).toBe(true);
    expect(v.firstAgentExempt).toBe(true);
    // The axis that would have blocked does NOT vanish: the line on the card
    // says the start happened on a loaded machine, instead of pretending it
    // was free.
    expect(v.blockedBy).toBe("load");
  });

  it("l'esenzione vale solo a coda vuota: il secondo agente aspetta", () => {
    const v = machinePressureVerdict(machine({ load1: 40, running: 1 }), thresholds);
    expect(v.admit).toBe(false);
    expect(v.firstAgentExempt).toBe(false);
  });

  it("zero core non divide per zero", () => {
    expect(machinePressureVerdict(machine({ cores: 0, load1: 0 }), thresholds).loadRatio).toBe(0);
  });
});

describe("capThresholds / capMode — ciò che è scritto e ciò che si applica", () => {
  it("senza campi vale il default, e il default è «per numero»", () => {
    expect(capMode({})).toBe("count");
    expect(capThresholds({})).toEqual({ maxLoadRatio: LOAD_RATIO_DEFAULT, maxMemRatio: MEM_RATIO_DEFAULT });
  });

  it("un valore fuori scala viene stretto, non rifiutato", () => {
    expect(capThresholds({ maxLoadRatio: 99 }).maxLoadRatio).toBe(LOAD_RATIO_MAX);
    expect(capThresholds({ maxMemRatio: 0.1 }).maxMemRatio).toBe(0.5);
  });

  it("un valore illeggibile ricade sul default invece che su zero", () => {
    expect(capThresholds({ maxLoadRatio: Number.NaN }).maxLoadRatio).toBe(LOAD_RATIO_DEFAULT);
  });

  it("una modalità sconosciuta non attiva il freno per sbaglio", () => {
    expect(capMode({ mode: "risorse" as never })).toBe("count");
    expect(capMode({ mode: "resources" })).toBe("resources");
  });
});

describe("le fasce di colore — due modi di sbagliare una soglia, non uno", () => {
  it("il verde è la fascia consigliata, e sta in mezzo", () => {
    expect(loadThresholdBand(0.9)).toBe("green");
    expect(memThresholdBand(0.85)).toBe("green");
  });

  it("troppo bassa è rossa quanto troppo alta: la coda non partirebbe mai", () => {
    expect(loadThresholdBand(0.25)).toBe("red");
    expect(loadThresholdBand(2)).toBe("red");
    expect(memThresholdBand(0.55)).toBe("red");
    expect(memThresholdBand(0.97)).toBe("red");
  });

  it("il giallo è la fascia usabile ma fuori dal consiglio", () => {
    expect(loadThresholdBand(0.5)).toBe("amber");
    expect(loadThresholdBand(1.4)).toBe("amber");
    expect(memThresholdBand(0.65)).toBe("amber");
  });

  it("la macchina viva si colora contro la soglia scelta, non contro un assoluto", () => {
    expect(livePressureBand(0.2, 0.9)).toBe("green");
    expect(livePressureBand(0.7, 0.9)).toBe("amber");
    expect(livePressureBand(0.9, 0.9)).toBe("red");
  });
});
