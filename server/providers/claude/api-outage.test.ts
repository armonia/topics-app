/**
 * What a live line says about the API, and how a turn the send watchdog closed
 * ends (card e30f35e4). The integration test drives these through a fake CLI;
 * here are the branches it cannot tell apart, each of which would read a
 * stall as an outage: the hold then stops the resume, the board and the
 * routing for every Claude chat, and the cut turn waits for an API that was
 * never down.
 *
 * @covers RESUME-04
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { noteApiHealth, silentTurnEnd } from "./api-outage";
import { clearProviderHold, providerHold, resetProviderHoldStore } from "../../lib/provider-hold";

const NOW = 1_800_000_000_000;
const retry = (error_status: number | null) => ({
  type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 8000, error_status,
});

beforeEach(() => { clearProviderHold(); resetProviderHoldStore(); });
afterEach(() => { clearProviderHold(); resetProviderHoldStore(); });

describe("noteApiHealth", () => {
  test("a retry of an API that is down opens the outage hold", () => {
    expect(noteApiHealth("noise", retry(null), NOW)).toMatchObject({ at: NOW, outage: true });
    expect(providerHold(NOW)?.window).toBe("api-down");
  });

  test("a 429 retry is kept on the child but opens no hold: the API is up, the plan says wait", () => {
    expect(noteApiHealth("noise", retry(429), NOW)).toMatchObject({ at: NOW, outage: false });
    expect(providerHold(NOW)).toBeNull();
  });
});

describe("silentTurnEnd", () => {
  const detail = "Nessuna attività dal modello per 30 minuti. Turno terminato.";

  test("the child's last word a retry of an API that is down: the API left the turn unanswered", () => {
    expect(silentTurnEnd({ at: NOW, outage: true }, NOW - 60_000, detail, NOW + 1)).toMatchObject({ end: "error", cause: "api-unavailable" });
    expect(providerHold(NOW + 1)?.window).toBe("api-down");
  });

  test("a 429 retry, or a retry with events after it, is a stall of ours and opens no hold", () => {
    expect(silentTurnEnd({ at: NOW, outage: false }, NOW - 60_000, detail, NOW + 1)).toMatchObject({ end: "cancelled", cause: "watchdog" });
    expect(silentTurnEnd({ at: NOW, outage: true }, NOW + 1, detail, NOW + 2)).toMatchObject({ end: "cancelled", cause: "watchdog" });
    expect(providerHold(NOW + 2)).toBeNull();
  });
});
