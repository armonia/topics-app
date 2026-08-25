/**
 * @covers ENVALIAS-01
 */
// Deprecated-env-alias helper: canonical wins, alias is a warned fallback.
import { test, expect, afterEach } from "bun:test";
import { readEnvWithAlias, warnDeprecatedEnv, __resetDeprecatedEnvWarnings } from "./env-alias";

const CANON = "TEST_CANONICAL_ENV";
const ALIAS = "TEST_ALIAS_ENV";

afterEach(() => {
  delete process.env[CANON];
  delete process.env[ALIAS];
  __resetDeprecatedEnvWarnings();
});

test("canonical value wins over alias and never warns", () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: any[]) => warns.push(String(a[0]));
  try {
    process.env[CANON] = "canon";
    process.env[ALIAS] = "legacy";
    expect(readEnvWithAlias(CANON, ALIAS)).toBe("canon");
    expect(warns.length).toBe(0);
  } finally {
    console.warn = orig;
  }
});

test("alias is honoured as fallback and warns exactly once", () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: any[]) => warns.push(String(a[0]));
  try {
    process.env[ALIAS] = "legacy";
    expect(readEnvWithAlias(CANON, ALIAS)).toBe("legacy");
    expect(readEnvWithAlias(CANON, ALIAS)).toBe("legacy");
    expect(warns.filter((w) => w.includes(ALIAS)).length).toBe(1);
  } finally {
    console.warn = orig;
  }
});

test("empty strings are treated as unset", () => {
  process.env[CANON] = "";
  process.env[ALIAS] = "";
  expect(readEnvWithAlias(CANON, ALIAS)).toBeUndefined();
});

test("warnDeprecatedEnv dedupes per alias name", () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: any[]) => warns.push(String(a[0]));
  try {
    warnDeprecatedEnv(ALIAS, CANON);
    warnDeprecatedEnv(ALIAS, CANON);
    expect(warns.length).toBe(1);
  } finally {
    console.warn = orig;
  }
});
