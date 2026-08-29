/**
 * The land checks the ARTIFACT, not the exit code.
 *
 * On 29/08, after three back-to-back lands, `public/assets/` was empty and
 * `public/index.html` gone: `vite build` runs with `emptyOutDir` (wipe first,
 * write after) and had been killed in between. Every gate was green and the
 * card said "client rebuilt": the only broken thing was the app people load.
 *
 * @covers LAND-10
 */
import { describe, test, expect } from "bun:test";
import { createTaskAutoMerge } from "./task-automerge";

function automerge(opts: {
  builds: Array<{ code: number }>;
  /** Bundle state seen after build N (index = call count - 1). */
  bundle: Array<string | null>;
}) {
  let calls = 0;
  const am = createTaskAutoMerge({
    resolveTaskMerge: () => null,
    runBuild: async () => {
      const r = opts.builds[Math.min(calls, opts.builds.length - 1)];
      calls++;
      return { code: r.code, stdout: "", stderr: r.code === 0 ? "" : "boom" };
    },
    verifyBundle: () => opts.bundle[Math.min(calls - 1, opts.bundle.length - 1)] ?? null,
  });
  return { am, builds: () => calls };
}

describe("buildClient", () => {
  test("a build that leaves a servable bundle builds once and answers 0", async () => {
    const { am, builds } = automerge({ builds: [{ code: 0 }], bundle: [null] });
    const res = await am.buildClient("/repo");
    expect(res.code).toBe(0);
    expect(res.artifact).toBeNull();
    expect(builds()).toBe(1);
  });

  test("exit 0 with an empty public/ is rebuilt once, and then it is fine", async () => {
    const { am, builds } = automerge({
      builds: [{ code: 0 }, { code: 0 }],
      bundle: ["public: index.html", null],
    });
    const res = await am.buildClient("/repo");
    expect(res.code).toBe(0);
    expect(builds()).toBe(2);
  });

  test("still no bundle after the retry: non-zero, with the reason", async () => {
    const { am, builds } = automerge({
      builds: [{ code: 0 }, { code: 0 }],
      bundle: ["public: index.html", "public: index.html"],
    });
    const res = await am.buildClient("/repo");
    // Exit 0 must NOT be an answer when the artifact is not there.
    expect(res.code).not.toBe(0);
    expect(res.artifact).toContain("index.html");
    expect(builds()).toBe(2);
  });

  test("a build that fails is retried too, and keeps its exit code", async () => {
    const { am, builds } = automerge({ builds: [{ code: 1 }, { code: 1 }], bundle: [null, null] });
    const res = await am.buildClient("/repo");
    expect(res.code).toBe(1);
    expect(builds()).toBe(2);
  });
});
