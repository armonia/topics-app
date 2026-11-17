/** @covers LAND-16 */
import { describe, expect, test } from "bun:test";
import { watchMainCi, type MainCiCommit, type MainCiPort, type MainCiVerdict } from "./main-ci-watch";

const NOW = 1_800_000_000;
const commit = (sha: string, ageS = 3600): MainCiCommit => ({ sha, subject: `commit ${sha}`, at: NOW - ageS });
const v = (state: MainCiVerdict["state"]): MainCiVerdict => ({ state, failed: state === "fail" ? ["gates"] : [], url: "https://ci/run/1" });

function world(commits: MainCiCommit[], verdicts: Record<string, MainCiVerdict>, owned: string[] = []) {
  const opened: string[] = [];
  const port: MainCiPort = { recent: async () => commits, verdict: async (sha) => verdicts[sha]!, entersAt: async () => false };
  const deps = {
    port, now: () => NOW * 1000,
    owned: async (sha: string) => owned.includes(sha),
    open: (c: MainCiCommit) => { if (opened.includes(c.sha)) return false; opened.push(c.sha); return true; },
  };
  return { deps, opened };
}

describe("watchMainCi", () => {
  test("the newest commit with an answer decides: green opens nothing", async () => {
    const w = world([commit("b"), commit("a")], { b: v("pass"), a: v("fail") });
    expect(await watchMainCi(w.deps)).toBe("green");
    expect(w.opened).toEqual([]);
  });

  test("a red nobody owns opens ONE card, and the second pass finds it", async () => {
    const w = world([commit("b")], { b: v("fail") });
    expect(await watchMainCi(w.deps)).toBe("opened");
    expect(await watchMainCi(w.deps)).toBe("exists");
    expect(w.opened).toEqual(["b"]);
  });

  test("a red a card of the after rule carries is that card's: no second card", async () => {
    const w = world([commit("b")], { b: v("fail") }, ["b"]);
    expect(await watchMainCi(w.deps)).toBe("owned");
    expect(w.opened).toEqual([]);
  });

  test("a CI still running is asked again, never judged; an older red does not speak over a newer pending", async () => {
    const w = world([commit("c"), commit("b")], { c: v("pending"), b: v("fail") });
    expect(await watchMainCi(w.deps)).toBe("pending");
    expect(w.opened).toEqual([]);
  });

  test("no run for a commit: a young one may not have it listed yet, an old one means the CI skipped it and the one before speaks", async () => {
    const young = world([commit("c", 60), commit("b")], { c: v("none"), b: v("fail") });
    expect(await watchMainCi(young.deps)).toBe("pending");
    const old = world([commit("c", 3 * 3600), commit("b", 4 * 3600)], { c: v("none"), b: v("fail") });
    expect(await watchMainCi(old.deps)).toBe("opened");
    expect(old.opened).toEqual(["b"]);
    const nothing = world([commit("c", 3 * 3600)], { c: v("none") });
    expect(await watchMainCi(nothing.deps)).toBe("no-ci");
  });
});
