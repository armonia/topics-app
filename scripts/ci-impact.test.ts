import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_REDUCED, coversOf, failedImpact, planFiles, scopeE2e, specFilesOfList } from "./ci-impact";

const spec = (name: string, text = "") => ({ file: `tests/e2e/${name}`, text });
const SPECS = [
  spec("sidebar.spec.ts", "getByTestId('sidebar-row')\n * @covers SIDE-01"),
  spec("chat.spec.ts"),
  spec("terminal.spec.ts"),
  spec("topics-archive-boot.spec.ts"),
  spec("billing.spec.ts", "getByTestId('billing-panel')\n * @covers BILL-01"),
];
const noFile = () => null;

// `selectSpecs` reads the changed source from the working directory, so the fixture lives in one.
const here = process.cwd();
let sandbox = "";
beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "ci-impact-"));
  mkdirSync(join(sandbox, "client/src/components"), { recursive: true });
  writeFileSync(join(sandbox, "client/src/components/Billing.tsx"), '<div data-testid="billing-panel" />');
  mkdirSync(join(sandbox, "server/services"), { recursive: true });
  writeFileSync(join(sandbox, "server/services/orphan.ts"), "export const x = 1;");
  process.chdir(sandbox);
});
afterAll(() => {
  process.chdir(here);
  rmSync(sandbox, { recursive: true, force: true });
});

describe("scopeE2e", () => {
  test("a change linked to one spec runs that spec and the smoke", () => {
    const read = (f: string) => (f === "client/src/components/Billing.tsx" ? "ok" : null);
    const scope = scopeE2e(["client/src/components/Billing.tsx"], SPECS, read);
    expect(scope.kind).toBe("reduced");
    if (scope.kind === "reduced") expect(scope.files).toEqual(["billing.spec.ts", "chat.spec.ts", "sidebar.spec.ts", "terminal.spec.ts", "topics-archive-boot.spec.ts"]);
  });

  test("a source file no spec is linked to falls back to the whole tier", () => {
    const read = () => "export const x = 1;";
    expect(scopeE2e(["server/services/orphan.ts"], SPECS, read).kind).toBe("full");
  });

  test("a file every spec reads falls back to the whole tier", () => {
    for (const f of ["playwright.config.ts", "package.json", "tests/e2e/fixtures/hermetic.ts", ".github/workflows/ci.yml"]) {
      expect(scopeE2e([f], SPECS, noFile).kind).toBe("full");
    }
  });

  test("a changed test runs the specs that cover the same requirement", () => {
    const read = () => "/** @covers BILL-01 */";
    const scope = scopeE2e(["tests/unit/billing.test.ts"], SPECS, read);
    expect(scope.kind === "reduced" && scope.files).toContain("billing.spec.ts");
  });

  test("a changed spec runs itself", () => {
    const scope = scopeE2e(["tests/e2e/billing.spec.ts"], SPECS, noFile);
    expect(scope.kind === "reduced" && scope.files).toContain("billing.spec.ts");
  });

  test("a docs-only change runs the smoke and nothing else", () => {
    const scope = scopeE2e(["docs/readme.md"], SPECS, noFile);
    expect(scope.kind === "reduced" && scope.files).toHaveLength(4);
  });

  test("a css, sql or shell file is traced to no spec and runs the whole tier", () => {
    const read = () => "x";
    for (const f of ["client/src/index.css", "server/migrations/001_init.sql", "scripts/start-test-server.sh"]) {
      expect(scopeE2e([f], SPECS, read).kind).toBe("full");
    }
  });

  test("prose and assets stay inert, and a deleted untraceable file blames nobody", () => {
    expect(scopeE2e(["CHANGELOG.md", "client/public/logo.png"], SPECS, () => "x").kind).toBe("reduced");
    expect(scopeE2e(["scripts/gone.sh"], SPECS, noFile).kind).toBe("reduced");
  });

  test("a change that reaches more than the cap is the whole tier", () => {
    const many = Array.from({ length: MAX_REDUCED + 1 }, (_, i) => `tests/e2e/spec-${i}.spec.ts`);
    expect(scopeE2e(many, SPECS, noFile).kind).toBe("full");
  });
});

describe("failedImpact", () => {
  test("runs the whole tier and does not mark the tree as judged", () => {
    const i = failedImpact(new Error("boom"));
    expect(i.e2e.kind).toBe("full");
    expect(i.unit.kind).toBe("full");
    expect(i.reduced).toBe(true);
  });
});

describe("helpers", () => {
  test("coversOf reads every requirement id", () => {
    expect(coversOf(" * @covers A-1\n * @covers BB2-30")).toEqual(["A-1", "BB2-30"]);
  });

  test("planFiles merges the selection with --only-changed, sorted and unique", () => {
    expect(planFiles(["b.spec.ts", "a.spec.ts"], ["c.spec.ts", "a.spec.ts"])).toEqual(["a.spec.ts", "b.spec.ts", "c.spec.ts"]);
  });

  test("specFilesOfList names the spec files of a Playwright list", () => {
    const json = JSON.stringify({ suites: [{ file: "a.spec.ts", suites: [{ specs: [{ file: "b/c.spec.ts" }] }] }] });
    expect(specFilesOfList(json)).toEqual(["c.spec.ts"]);
  });
});
