import { describe, expect, it } from "bun:test";
import {
  creaIdentitaRelay, creaProvaHost, FORMA_RELAY_ID, INTESTAZIONE_PROVA_HOST,
  LUNGHEZZA_RELAY_ID, PROVA_HOST_ANTICIPO_MS, PROVA_HOST_VALIDITA_MS, verificaProvaHost,
} from "./relay-identita";

describe("relay host proof", () => {
  it("binds the public relay ID to the private signing key", async () => {
    const identity = await creaIdentitaRelay();
    expect(identity.relayId).toHaveLength(LUNGHEZZA_RELAY_ID);
    expect(FORMA_RELAY_ID.test(identity.relayId)).toBe(true);
    const proof = await creaProvaHost(identity.segreto, identity.relayId, 10_000);
    expect(await verificaProvaHost(proof, identity.relayId, 10_000)).toBe(true);
    expect(await verificaProvaHost(proof, "another-relay-name", 10_000)).toBe(false);
  });

  it("expires captured proofs after one minute", async () => {
    const identity = await creaIdentitaRelay();
    const proof = await creaProvaHost(identity.segreto, identity.relayId, 10_000);
    expect(await verificaProvaHost(proof, identity.relayId, 10_000 + PROVA_HOST_VALIDITA_MS)).toBe(true);
    expect(await verificaProvaHost(proof, identity.relayId, 10_001 + PROVA_HOST_VALIDITA_MS)).toBe(false);
  });

  it("accepts a host clock a little ahead of the Worker's, not a proof minted for later", async () => {
    const identity = await creaIdentitaRelay();
    const proof = await creaProvaHost(identity.segreto, identity.relayId, 100_000);
    // A Mac ahead by one millisecond used to be refused on every connection.
    expect(await verificaProvaHost(proof, identity.relayId, 99_999)).toBe(true);
    expect(await verificaProvaHost(proof, identity.relayId, 100_000 - PROVA_HOST_ANTICIPO_MS)).toBe(true);
    expect(await verificaProvaHost(proof, identity.relayId, 99_999 - PROVA_HOST_ANTICIPO_MS)).toBe(false);
  });

  it("rejects malformed proofs and keeps the proof header outside the relay tunnel headers", async () => {
    const identity = await creaIdentitaRelay();
    expect(await verificaProvaHost("malformed", identity.relayId)).toBe(false);
    const { intestazioniRichiesta } = await import("./relay-http");
    expect(INTESTAZIONE_PROVA_HOST).toBe(INTESTAZIONE_PROVA_HOST.toLowerCase());
    expect(intestazioniRichiesta([[INTESTAZIONE_PROVA_HOST, "proof"]]))
      .toEqual([[INTESTAZIONE_PROVA_HOST, "proof"]]);
  });
});
