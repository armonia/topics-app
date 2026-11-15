/**
 * @covers TERM-01
 *
 * parseProbeFrame — pure parse/validate for one JSON-line frame on the probe
 * socket (server/pty-bridge.mjs, probeBridge()). Extracted so it is testable
 * without importing pty-bridge.mjs, whose module-level `start()` would spin up
 * the whole daemon.
 *
 * Regression: the previous inline `try { JSON.parse(line) } catch {}` wrapped
 * BOTH the parse and the rest of the handler, so a handler failure (for
 * example a write on a torn-down socket) was swallowed and the probe never
 * finished. parseProbeFrame only parses and validates: it rejects non-object
 * frames so the caller can `continue`, and the handler runs outside any try.
 */
import { describe, expect, test } from "bun:test";
import { parseProbeFrame } from "./pty-bridge-platform.mjs";

describe("parseProbeFrame", () => {
  test("parses a valid frame object", () => {
    expect(parseProbeFrame('{"type":"created","id":"abc"}')).toEqual({ type: "created", id: "abc" });
  });

  test("rejects invalid JSON", () => {
    expect(parseProbeFrame("not json")).toBeNull();
  });

  test("rejects a bare `null` line instead of letting it through as a frame", () => {
    expect(parseProbeFrame("null")).toBeNull();
  });

  test("rejects primitive JSON values (number, string, boolean)", () => {
    expect(parseProbeFrame("42")).toBeNull();
    expect(parseProbeFrame('"hello"')).toBeNull();
    expect(parseProbeFrame("true")).toBeNull();
  });
});
