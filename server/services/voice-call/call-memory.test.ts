/**
 * The short memory between two calls of the same person.
 * @covers CALL-04
 */
import { expect, test } from "bun:test";
import { RESUME_WINDOW, previousCall, rememberCall } from "./call-memory";

test("a call back within the window gets the thread once; later, or for someone else, nothing", () => {
  rememberCall("Ada", ["Ada: e il preventivo?"], true, 1000);
  expect(previousCall("Bea", 2000)).toBeNull();
  expect(previousCall("Ada", 1000 + 90_000)).toEqual({ lines: ["Ada: e il preventivo?"], dropped: true, agoMin: 2 });
  expect(previousCall("Ada", 1000 + 100_000)).toBeNull();
  rememberCall("Ada", ["Ada: ciao"], false, 0);
  expect(previousCall("Ada", RESUME_WINDOW + 1)).toBeNull();
  rememberCall("Ada", [], true, 0);
  expect(previousCall("Ada", 1)).toBeNull();
  // a window of 0 (the bench) never resumes
  rememberCall("Ada", ["Ada: e il preventivo?"], true, 0);
  expect(previousCall("Ada", 1, 0)).toBeNull();
});
