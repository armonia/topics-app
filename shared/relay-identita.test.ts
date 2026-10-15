/**
 * The machine's name on the relay and its proof: what has to hold.
 *
 * That nobody can sign for a name without the private key is ECDSA's job, not a test's. Here: the
 * name binds to the key, a proof stops working after a minute, a clock a little ahead still
 * attaches, and anything malformed falls on the side of the refusal.
 *
 * @covers RELAY-E2E-12
 */
import { describe, expect, it } from "bun:test";
import {
  createRelayIdentity, createHostProof, FORMA_RELAY_ID, HOST_PROOF_HEADER,
  LUNGHEZZA_RELAY_ID, HOST_PROOF_MAX_SKEW_MS, HOST_PROOF_TTL_MS, verifyHostProof,
} from "./relay-identita";

describe("relay host proof", () => {
  it("binds the public relay ID to the private signing key", async () => {
    const identity = await createRelayIdentity();
    expect(identity.relayId).toHaveLength(LUNGHEZZA_RELAY_ID);
    expect(FORMA_RELAY_ID.test(identity.relayId)).toBe(true);
    const proof = await createHostProof(identity.segreto, identity.relayId, 10_000);
    expect(await verifyHostProof(proof, identity.relayId, 10_000)).toBe(true);
    expect(await verifyHostProof(proof, "another-relay-name", 10_000)).toBe(false);
  });

  it("expires captured proofs after one minute", async () => {
    const identity = await createRelayIdentity();
    const proof = await createHostProof(identity.segreto, identity.relayId, 10_000);
    expect(await verifyHostProof(proof, identity.relayId, 10_000 + HOST_PROOF_TTL_MS)).toBe(true);
    expect(await verifyHostProof(proof, identity.relayId, 10_001 + HOST_PROOF_TTL_MS)).toBe(false);
  });

  it("accepts a host clock a little ahead of the Worker's, not a proof minted for later", async () => {
    const identity = await createRelayIdentity();
    const proof = await createHostProof(identity.segreto, identity.relayId, 100_000);
    // A Mac ahead by one millisecond used to be refused on every connection.
    expect(await verifyHostProof(proof, identity.relayId, 99_999)).toBe(true);
    expect(await verifyHostProof(proof, identity.relayId, 100_000 - HOST_PROOF_MAX_SKEW_MS)).toBe(true);
    expect(await verifyHostProof(proof, identity.relayId, 99_999 - HOST_PROOF_MAX_SKEW_MS)).toBe(false);
  });

  it("rejects malformed proofs and keeps the proof header outside the relay tunnel headers", async () => {
    const identity = await createRelayIdentity();
    expect(await verifyHostProof("malformed", identity.relayId)).toBe(false);
    const { intestazioniRichiesta } = await import("./relay-http");
    expect(HOST_PROOF_HEADER).toBe(HOST_PROOF_HEADER.toLowerCase());
    expect(intestazioniRichiesta([[HOST_PROOF_HEADER, "proof"]]))
      .toEqual([[HOST_PROOF_HEADER, "proof"]]);
  });
});
