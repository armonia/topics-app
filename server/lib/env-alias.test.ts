/**
 * @covers ENVALIAS-01
 */
// Deprecated-env-alias helper: canonical wins, alias is a warned fallback.
import { test, expect, afterEach } from "bun:test";
import { warnDeprecatedEnv, __resetDeprecatedEnvWarnings } from "./env-alias";

const CANON = "TEST_CANONICAL_ENV";
const ALIAS = "TEST_ALIAS_ENV";

afterEach(() => {
  delete process.env[CANON];
  delete process.env[ALIAS];
  __resetDeprecatedEnvWarnings();
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
