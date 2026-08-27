import { describe, expect, it } from "bun:test";
import { classify, collectLost } from "./check-e2e-no-verdict";

/**
 * @covers GATE-11
 *
 * The one thing worth testing here is the LINE between a declared skip and a
 * test that vanished: get it wrong in one direction and the gate cries wolf on
 * every `test.skip` in the suite, get it wrong in the other and it stays as
 * silent as the yellow summary line it exists to replace.
 */
describe("check-e2e-no-verdict", () => {
  it("says nothing about a test that passed", () => {
    expect(classify({ status: "expected", results: [{ status: "passed" }] })).toBeNull();
  });

  it("says nothing about a test that failed: a red has its own verdict", () => {
    expect(classify({ status: "unexpected", results: [{ status: "failed" }] })).toBeNull();
  });

  it("says nothing about a skip somebody declared", () => {
    expect(
      classify({ status: "skipped", expectedStatus: "skipped", results: [{ status: "skipped" }] }),
    ).toBeNull();
  });

  it("catches a test with no results at all: nobody ever started it", () => {
    expect(classify({ status: "skipped", expectedStatus: "passed", results: [] })).toBe("did-not-run");
  });

  it("catches a skip nobody asked for (expectedStatus is not skipped)", () => {
    expect(
      classify({ status: "skipped", expectedStatus: "passed", results: [{ status: "skipped" }] }),
    ).toBe("did-not-run");
  });

  it("tells an interrupted test apart: it had started when the worker went down", () => {
    expect(
      classify({ status: "skipped", expectedStatus: "passed", results: [{ status: "interrupted" }] }),
    ).toBe("interrupted");
  });

  it("collects the lost ones from the report tree, with file and title", () => {
    const lost = collectLost({
      suites: [
        {
          file: "tests/e2e/a.spec.ts",
          specs: [
            {
              file: "tests/e2e/a.spec.ts",
              title: "ok",
              tests: [{ status: "expected", results: [{ status: "passed" }] }],
            },
          ],
          suites: [
            {
              file: "tests/e2e/a.spec.ts",
              specs: [
                {
                  file: "tests/e2e/a.spec.ts",
                  title: "mai partito",
                  line: 42,
                  tests: [{ status: "skipped", expectedStatus: "passed", results: [] }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(lost).toEqual([
      { file: "tests/e2e/a.spec.ts", title: "mai partito", line: 42, kind: "did-not-run" },
    ]);
  });

  it("stays quiet on a wholly green report", () => {
    expect(
      collectLost({
        suites: [
          {
            file: "tests/e2e/b.spec.ts",
            specs: [
              {
                file: "tests/e2e/b.spec.ts",
                title: "verde",
                tests: [{ status: "expected", results: [{ status: "passed" }] }],
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
});
