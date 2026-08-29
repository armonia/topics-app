/**
 * @covers LAND-12
 */
import { describe, expect, test } from "bun:test";
import { startBundleProbe } from "./bundle-probe";

function probeOn(states: Array<string | null>) {
  const lines: string[] = [];
  let i = 0;
  let clock = 1_000;
  const probe = startBundleProbe({
    publicDir: "/repo/public",
    schedule: false,
    verify: () => states[Math.min(i, states.length - 1)] ?? null,
    log: (l) => lines.push(l),
    now: () => clock,
  });
  return {
    probe,
    lines,
    step(advanceMs = 60_000) { i++; clock += advanceMs; return probe.check(); },
    advance(ms: number) { clock += ms; return probe.check(); },
  };
}

describe("startBundleProbe", () => {
  test("a whole bundle says nothing", () => {
    const p = probeOn([null]);
    expect(p.probe.state().ok).toBe(true);
    expect(p.lines).toEqual([]);
  });

  test("the bundle disappearing under a live server is an alarm", () => {
    const p = probeOn([null, "public: index.html"]);
    const s = p.step();
    expect(s.ok).toBe(false);
    expect(s.reason).toContain("index.html");
    expect(p.lines[0]).toContain("ALARM");
    expect(p.lines[0]).toContain("build:client");
  });

  test("it does not repeat the alarm at every check, but it does not go quiet either", () => {
    const p = probeOn([null, "public: index.html"]);
    p.step();
    p.advance(60_000);
    p.advance(60_000);
    expect(p.lines).toHaveLength(1);
    p.advance(10 * 60_000);
    expect(p.lines).toHaveLength(2);
    expect(p.lines[1]).toContain("STILL broken");
  });

  test("a rebuild that fixes it is stated once", () => {
    const p = probeOn([null, "public: index.html", null]);
    p.step();
    const back = p.step();
    expect(back.ok).toBe(true);
    expect(p.lines[1]).toContain("servable again");
  });
});
