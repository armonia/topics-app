/** @covers HUBBR-21 */
import { describe, expect, test } from "bun:test";
import { machinesForScreen, remoteReportOf } from "./screen";

describe("remoteReportOf", () => {
  test("no jobs, or no answer from the machine, is still a report: the page must not fall back on an older list", () => {
    expect(remoteReportOf({ machine: { name: "PC" }, readout: { procs: [], cores: 16, screen: { jobs: [] } } })).toEqual({
      machine: "PC", jobs: [], load: { memMB: null, cpuPct: null },
    });
    expect(remoteReportOf({ machine: null, readout: null })).toEqual({ machine: null, jobs: [], load: { memMB: null, cpuPct: null } });
  });

  test("a job with no repository (a sender from before it wrote one) keeps it null", () => {
    const r = remoteReportOf({ machine: { name: "PC" }, readout: { cores: 8, procs: [], screen: { jobs: [{ project: "Acme web", what: "tests" }] } } });
    expect(r.jobs).toEqual([{ project: "Acme web", repo: null, what: "tests", who: null, since: null }]);
  });

  test("the jobs and the load of the processes flagged as sent work, on the machine's own 0-100 scale", () => {
    const r = remoteReportOf({
      machine: { name: "PC" },
      readout: {
        cores: 8,
        procs: [{ memMB: 1000, cpuPct: 200, job: true }, { memMB: 500, cpuPct: 100, job: true }, { memMB: 9000, cpuPct: 50 }],
        screen: { jobs: [{ project: "Acme web", repo: "/Users/x/Projects/acme-web", what: "tests", who: "Mac", since: 5 }] },
      },
    });
    // The repository travels with the label: it is what places the job on a session.
    expect(r.jobs).toEqual([{ project: "Acme web", repo: "/Users/x/Projects/acme-web", what: "tests", who: "Mac", since: 5 }]);
    expect(r.load).toEqual({ memMB: 1500, cpuPct: 300 / 8 });
  });
});

describe("machinesForScreen", () => {
  test("keeps what the page draws and drops the hub's sentences, programs and services", () => {
    const cut = machinesForScreen([{
      id: "mac", local: true, state: "acceso", level: 1, lines: ["project X is paused"], caption: "c", offload: 2,
      procs: [{ name: "secret-tool", cores: 3 }],
      metrics: [{ key: "cpu", name: "CPU", pct: 12, note: "4 cores", history: [{ t: 1, v: 2 }], extra: "x" }],
    }]);
    expect(cut).toEqual([{ local: true, state: "acceso", metrics: [{ key: "cpu", name: "CPU", pct: 12, note: "4 cores", history: [{ t: 1, v: 2 }] }] }]);
  });

  test("anything that is not a list is no answer", () => {
    expect(machinesForScreen({ error: "x" })).toBeNull();
  });
});
