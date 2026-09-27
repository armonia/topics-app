/**
 * THREE STATES OF ONE GLYPH, and which one wins.
 *
 * The blue ring that turns says "answering, a message would queue"; the amber
 * one standing still says "your move". A chat whose closed turn left an agent
 * or a Bash running is neither: nothing answers and nothing waits for you, the
 * work runs by itself and the chat is free. It gets the third, grey and slow,
 * and on one row or one folder the precedence is waiting > working > background.
 *
 * @covers BGVIS-01
 */
import { describe, expect, test } from "bun:test";
import { loaderStateFor } from "./loaderState";

describe("loaderStateFor", () => {
  test("nothing open and nothing in the background draws nothing", () => {
    expect(loaderStateFor({ loading: false, waiting: false, background: false })).toBeNull();
  });

  test("background work alone is its own grey state, not a turn", () => {
    expect(loaderStateFor({ loading: false, waiting: false, background: true })).toBe("background");
  });

  test("a real turn wins over the background", () => {
    expect(loaderStateFor({ loading: true, waiting: false, background: true })).toBe("working");
  });

  test("a wait for you wins over both", () => {
    expect(loaderStateFor({ loading: true, waiting: true, background: true })).toBe("waiting");
    expect(loaderStateFor({ loading: false, waiting: true, background: true })).toBe("waiting");
  });

  test("a wait with nothing open and nothing running draws nothing, as before", () => {
    expect(loaderStateFor({ loading: false, waiting: true, background: false })).toBeNull();
  });
});
