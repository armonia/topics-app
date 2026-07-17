import { describe, test, expect } from "bun:test";
import { shouldServeSpaFallback } from "./spa-fallback";

const HTML = "text/html,application/xhtml+xml";

describe("shouldServeSpaFallback", () => {
  test("serves the shell for a board deep-link navigation (/task/<uuid>)", () => {
    expect(shouldServeSpaFallback({
      method: "GET",
      pathname: "/task/d8ea2ff3-d412-4771-810d-401faa1d1754",
      accept: HTML,
    })).toBe(true);
  });

  test("serves the shell for a bare navigation path", () => {
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/settings", accept: HTML })).toBe(true);
  });

  test("an unknown /api/* route is NOT masked (stays 404)", () => {
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/api/does-not-exist", accept: HTML })).toBe(false);
  });

  test("a missing asset (path with an extension) is NOT masked (stays 404)", () => {
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/assets/missing.js", accept: HTML })).toBe(false);
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/favicon.ico", accept: HTML })).toBe(false);
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/foo/bar.png", accept: HTML })).toBe(false);
  });

  test("a /ws path is never the shell", () => {
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/ws/terminal/abc", accept: HTML })).toBe(false);
  });

  test("non-GET methods never get the shell", () => {
    expect(shouldServeSpaFallback({ method: "POST", pathname: "/task/x", accept: HTML })).toBe(false);
    expect(shouldServeSpaFallback({ method: "HEAD", pathname: "/task/x", accept: HTML })).toBe(false);
  });

  test("a non-HTML client (no text/html Accept) does not get the shell", () => {
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/task/x", accept: "application/json" })).toBe(false);
    expect(shouldServeSpaFallback({ method: "GET", pathname: "/task/x", accept: null })).toBe(false);
  });
});
