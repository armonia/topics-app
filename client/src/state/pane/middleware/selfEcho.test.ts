/**
 * Recognising the client's own writes coming back over the socket, so a
 * broadcast it caused does not overwrite what it already has.
 *
 * @covers TAB-SYNC-02
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  rememberLocalAck,
  isSelfEcho,
  resetSelfEcho,
  __getPendingAcks,
  __getLastEmittedServerSeq,
  __resetSelfEchoForTests,
} from "./selfEcho";

describe("selfEcho — short-TTL Map (level 1)", () => {
  beforeEach(() => __resetSelfEchoForTests());

  test("rememberLocalAck records the seq and isSelfEcho consumes it", () => {
    rememberLocalAck(42);
    expect(__getPendingAcks()).toEqual([42]);
    expect(isSelfEcho(42)).toBe(true);
    // Consumed on first hit so a monotonic server can't double-match.
    expect(__getPendingAcks()).toEqual([]);
  });

  test("non-numeric / non-finite seqs are ignored", () => {
    rememberLocalAck(Number.NaN);
    rememberLocalAck(Number.POSITIVE_INFINITY);
    rememberLocalAck(undefined as unknown as number);
    expect(__getPendingAcks()).toEqual([]);
    expect(__getLastEmittedServerSeq()).toBe(0);
  });

  test("isSelfEcho returns false for unknown seq", () => {
    rememberLocalAck(10);
    expect(isSelfEcho(11)).toBe(false);
    // Known seq still present for its legitimate consumer.
    expect(__getPendingAcks()).toContain(10);
  });
});

describe("selfEcho — TTL-free high-water mark (level 2, bug #3)", () => {
  beforeEach(() => __resetSelfEchoForTests());

  test("lastEmittedServerSeq tracks the max ack ever recorded", () => {
    rememberLocalAck(5);
    rememberLocalAck(12);
    rememberLocalAck(7); // out-of-order — mark must not regress
    expect(__getLastEmittedServerSeq()).toBe(12);
  });

  test(
    "TTL expired Map entry: isSelfEcho still returns true via high-water mark",
    () => {
      rememberLocalAck(50);
      // Simulate TTL expiry by consuming (drains Map, keeps mark).
      isSelfEcho(50);
      expect(__getPendingAcks()).toEqual([]);
      expect(__getLastEmittedServerSeq()).toBe(50);

      // A WS broadcast for seq 50 arrives late (post-TTL): still self-echo.
      expect(isSelfEcho(50)).toBe(true);
      // Anything below the mark is also self-echo (defence-in-depth).
      expect(isSelfEcho(49)).toBe(true);
      expect(isSelfEcho(1)).toBe(true);
      // Fresh seq above the mark is a real remote frame.
      expect(isSelfEcho(51)).toBe(false);
    },
  );

  test(
    "after Map consume, high-water mark is non-destructive — repeat lookups keep working",
    () => {
      rememberLocalAck(100);
      isSelfEcho(100); // drains Map entry
      // Multiple lookups at or below mark remain true.
      expect(isSelfEcho(100)).toBe(true);
      expect(isSelfEcho(100)).toBe(true);
      expect(isSelfEcho(99)).toBe(true);
      // Mark itself unchanged by lookups.
      expect(__getLastEmittedServerSeq()).toBe(100);
    },
  );

  test("seq 0 is not classified as self-echo even if mark is 0", () => {
    // Guard: default state has mark=0, but a stray frame at seq=0 must not
    // be mis-treated as self-echo (would break first-ever hydration).
    expect(__getLastEmittedServerSeq()).toBe(0);
    expect(isSelfEcho(0)).toBe(false);
  });
});

describe("selfEcho — resetSelfEcho (WS reconnect / server restart)", () => {
  beforeEach(() => __resetSelfEchoForTests());

  test("resetSelfEcho clears BOTH the Map and the high-water mark", () => {
    rememberLocalAck(100);
    rememberLocalAck(150);
    expect(__getLastEmittedServerSeq()).toBe(150);
    expect(__getPendingAcks().length).toBeGreaterThan(0);

    resetSelfEcho();

    expect(__getPendingAcks()).toEqual([]);
    expect(__getLastEmittedServerSeq()).toBe(0);
  });

  test(
    "post-reset: a new server's init at seq=1 is NOT misclassified as self-echo",
    () => {
      // Simulate: tab writes, server responds seq=50 → self-ack recorded.
      rememberLocalAck(50);
      // Server broadcasts echo (fills level-2 mark path regardless of Map state).
      isSelfEcho(50);
      expect(__getLastEmittedServerSeq()).toBe(50);

      // Server restarts; WS reconnects; middleware calls resetSelfEcho.
      resetSelfEcho();

      // New server begins emitting from seq=1. That MUST be applied as a
      // remote frame, not filtered as self-echo against stale pre-restart
      // high-water mark.
      expect(isSelfEcho(1)).toBe(false);
      expect(isSelfEcho(49)).toBe(false);
      expect(isSelfEcho(50)).toBe(false);
    },
  );
});
