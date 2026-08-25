/**
 * @covers WIRE-03
 */
import { describe, expect, test } from "bun:test";
import { shouldCompressFrame, MIN_COMPRESS_BYTES } from "./ws-compression";

/** The frame that pays for the whole thing: 86.2 KB of `ui-state:init`. */
const base = {
  type: "ui-state:init",
  bytes: 86_222,
  remote: true,
};

describe("shouldCompressFrame", () => {
  test("yes for the bootstrap frames towards a remote peer: 86 KB that become 21", () => {
    expect(shouldCompressFrame(base)).toBe(true);
    expect(shouldCompressFrame({ ...base, type: "unread:init", bytes: 81_713 })).toBe(true);
  });

  test("NO towards loopback: the Tauri shell and the CLI have no network in between", () => {
    expect(shouldCompressFrame({ ...base, remote: false })).toBe(false);
  });

  test("NO under one MTU: a 30 B frame costs 32 B raw and 38 B compressed", () => {
    expect(shouldCompressFrame({ ...base, bytes: MIN_COMPRESS_BYTES - 1 })).toBe(false);
    expect(shouldCompressFrame({ ...base, bytes: MIN_COMPRESS_BYTES })).toBe(true);
  });

  test("NO for PTY output that is a keystroke echo, a cursor move, a line", () => {
    for (const bytes of [1, 7, 73]) {
      expect(shouldCompressFrame({ type: null, bytes, remote: true })).toBe(false);
    }
  });

  test("YES for a PTY redraw or scrollback flush: 1,927 B of redraw gzip to 41", () => {
    expect(shouldCompressFrame({ type: null, bytes: 1_927, remote: true })).toBe(true);
  });

  test("NO for a screencast frame at any size: base64 JPEG is already compressed", () => {
    expect(shouldCompressFrame({ type: "frame", bytes: 101_687, remote: true })).toBe(false);
    expect(shouldCompressFrame({ type: "frame", bytes: 5_000_000, remote: true })).toBe(false);
  });

  test("the other frames of the browser socket are JSON and follow the size rule", () => {
    expect(shouldCompressFrame({ type: "dom_event", bytes: 4_000, remote: true })).toBe(true);
    expect(shouldCompressFrame({ type: "console", bytes: 200, remote: true })).toBe(false);
  });

  test("loopback wins over everything, including a frame worth 4x", () => {
    expect(shouldCompressFrame({ ...base, remote: false, bytes: 5_000_000 })).toBe(false);
  });

  test("a caller with its own threshold gets it respected", () => {
    expect(shouldCompressFrame({ ...base, bytes: 2_000, threshold: 4_000 })).toBe(false);
    expect(shouldCompressFrame({ ...base, bytes: 4_000, threshold: 4_000 })).toBe(true);
  });

  test("the threshold is the one shared with the HTTP side, one MTU", () => {
    expect(MIN_COMPRESS_BYTES).toBe(1400);
  });
});
