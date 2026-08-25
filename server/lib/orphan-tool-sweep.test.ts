/**
 * @covers RETIRE-10
 */
import { describe, expect, it } from "bun:test";
import { ORPHAN_ERRORS, finalizeOrphanTool } from "./orphan-tool-sweep";

const NOW = 1_700_000_000_000;

describe("sessione MORTA: si chiude tutto ciò che era rimasto appeso", () => {
  it("un tool in corso", () => {
    const tc: Record<string, unknown> = { status: "running", startedAt: NOW - 5_000 };
    expect(finalizeOrphanTool(tc, { now: NOW })).toBe(true);
    expect(tc.status).toBe("error");
    expect(tc.error).toBe(ORPHAN_ERRORS.running);
    // Il cronometro si ferma su quando era partito, non su «adesso»: una durata
    // gonfiata dal riavvio racconterebbe un tool lentissimo che non è esistito.
    expect(tc.endedAt).toBe(NOW - 5_000);
  });

  it("una domanda a schermo", () => {
    const tc: Record<string, unknown> = { status: "waiting_for_input" };
    expect(finalizeOrphanTool(tc, { now: NOW })).toBe(true);
    expect(tc.error).toBe(ORPHAN_ERRORS.question);
  });

  it("un permesso a schermo", () => {
    const tc: Record<string, unknown> = { status: "awaiting_permission" };
    expect(finalizeOrphanTool(tc, { now: NOW })).toBe(true);
    expect(tc.error).toBe(ORPHAN_ERRORS.permission);
  });

  it("e non tocca ciò che è già finito", () => {
    for (const status of ["success", "error"]) {
      const tc: Record<string, unknown> = { status };
      expect(finalizeOrphanTool(tc, { now: NOW })).toBe(false);
      expect(tc.status).toBe(status);
    }
    expect(finalizeOrphanTool(null)).toBe(false);
    expect(finalizeOrphanTool(undefined)).toBe(false);
  });
});

describe("sessione VIVA: si risparmia tutto, TRANNE il permesso", () => {
  const alive = { childAlive: true, now: NOW };

  it("un tool in corso può ancora consegnare", () => {
    const tc: Record<string, unknown> = { status: "running" };
    expect(finalizeOrphanTool(tc, alive)).toBe(false);
    expect(tc.status).toBe("running");
  });

  it("una domanda può ancora essere risposta", () => {
    // Bollarla qui è il modo in cui una domanda viva diventava un ⚠️ con il
    // tasto Retry al primo hot-reload (topic:ed2070df, 3 agosto).
    const tc: Record<string, unknown> = { status: "waiting_for_input" };
    expect(finalizeOrphanTool(tc, alive)).toBe(false);
    expect(tc.status).toBe("waiting_for_input");
  });

  it("un PERMESSO no: il suo rendez-vous è morto col processo, e si ridipinge da sé se è vivo", () => {
    // È il difetto del 7 agosto: due pannelli rimasti a schermo su turni morti,
    // risparmiati perché il broker elencava ancora la sessione. La chat chiedeva
    // un permesso che nessuno poteva più ricevere — e continuava a chiederlo
    // anche dopo aver messo l'autonomia su «libero».
    const tc: Record<string, unknown> = { status: "awaiting_permission" };
    expect(finalizeOrphanTool(tc, alive)).toBe(true);
    expect(tc.error).toBe(ORPHAN_ERRORS.permission);
  });
});

describe("una spiegazione già scritta vince sulla nostra", () => {
  it("chi sapeva di più ha parlato prima", () => {
    const tc: Record<string, unknown> = { status: "running", error: "Aborted by user" };
    expect(finalizeOrphanTool(tc, { now: NOW })).toBe(true);
    expect(tc.error).toBe("Aborted by user");
  });

  it("e un endedAt già stampato non si sposta", () => {
    const tc: Record<string, unknown> = { status: "running", startedAt: 1, endedAt: 42 };
    finalizeOrphanTool(tc, { now: NOW });
    expect(tc.endedAt).toBe(42);
  });
});
