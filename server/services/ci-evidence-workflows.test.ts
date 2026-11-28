/**
 * A CI row that names its workflow file (`github-ci:<file>.yml/<job>`): the
 * read, the red-run guard and the rerun follow that workflow, not only ci.yml.
 *
 * @covers KANBAN-86
 * @covers KANBAN-93
 */
import { describe, expect, test } from "bun:test";
import { awaitCiEvidence, readCiEvidence } from "./ci-evidence";
import { ciEvidenceJobName, ciEvidenceNamesAJob, ciEvidenceWorkflow, NOT_MEASURED_EXIT } from "../../shared/board";
import { SHA, fakeClock, fakePort, job, run } from "./ci-evidence.testkit";

const input = { cwd: "/tmp/wt", sha: SHA, taskId: "12345678-card" };

describe("a board whose CI is not in ci.yml", () => {
  const CHAIN = { name: "chain-ci", cmd: "github-ci:chain.yml/build" };
  const chainRun = (over = {}) => run({ id: 77, path: ".github/workflows/chain.yml", ...over });
  const portFor = (conclusion: string) => fakePort({
    runs: async () => ({ ok: true, value: [chainRun({ conclusion })] }),
    jobs: async (_repo, runId) => ({ ok: true, value: runId === 77 ? [job("build", conclusion)] : [] }),
  }).port;
  const wait = (port: ReturnType<typeof portFor>) =>
    awaitCiEvidence({ ...input, checks: [CHAIN] }, { port, ...fakeClock(), stopping: () => false }).then((r) => r[0]!);

  test("a declaration with no job is refused, the others are fine", () => {
    for (const cmd of ["github-ci:", "github-ci:  ", "github-ci:chain.yml/"]) expect(ciEvidenceNamesAJob({ cmd })).toBe(false);
    for (const cmd of ["github-ci:build", "github-ci:chain.yml/build", "bun run test"]) expect(ciEvidenceNamesAJob({ cmd })).toBe(true);
  });

  test("the declaration names the workflow file and the job", () => {
    expect(ciEvidenceJobName(CHAIN)).toBe("build");
    expect(ciEvidenceWorkflow(CHAIN)).toBe("chain.yml");
    expect(ciEvidenceWorkflow({ cmd: "github-ci:build" })).toBeNull();
  });

  test("the job green in that workflow is a pass, red is a fail (not pending)", async () => {
    expect((await wait(portFor("success"))).ok).toBe(true);
    const red = await wait(portFor("failure"));
    expect(red.ok).toBe(false);
    expect(red.code).not.toBe(NOT_MEASURED_EXIT);
  });

  test("a run of ci.yml alone does not answer for another workflow", () => {
    expect(readCiEvidence(CHAIN, SHA, [run()], [job("build", "success")]).kind).toBe("pending");
  });

  test("KANBAN-86: the declared job green on a run that concluded red does not close the card green", async () => {
    const port = fakePort({
      runs: async () => ({ ok: true, value: [chainRun({ conclusion: "failure" })] }),
      jobs: async () => ({ ok: true, value: [job("build", "success"), job("test", "failure")] }),
    }).port;
    const row = await wait(port);
    expect(row.ok).toBe(false);
  });

  test("KANBAN-93: a cancelled run of the declared workflow is re-run, with no ci.yml in the repo", async () => {
    const reruns: number[] = [];
    const fake = fakePort({
      rerun: async (_repo, id) => { reruns.push(id); return { ok: true, value: undefined }; },
      runs: async () => ({ ok: true, value: [chainRun({ conclusion: "cancelled" })] }),
      jobs: async () => ({ ok: true, value: [] }),
    });
    await wait(fake.port);
    expect(reruns).toEqual([77]);
  });

  test("KANBAN-93b: in a repo with both, the rerun is the declared workflow's run, not ci.yml's", async () => {
    const reruns: number[] = [];
    const fake = fakePort({
      rerun: async (_repo, id) => { reruns.push(id); return { ok: true, value: undefined }; },
      runs: async () => ({ ok: true, value: [run({ id: 10 }), chainRun({ conclusion: "cancelled" })] }),
      jobs: async (_repo, runId) => ({ ok: true, value: runId === 10 ? [job("check", "success")] : [] }),
    });
    await wait(fake.port);
    expect(reruns).toEqual([77]);
  });

  test("KANBAN-93c: two workflows both cancelled get one rerun each, and neither row claims a rerun it did not get", async () => {
    for (const [first, second] of [[run({ id: 10, conclusion: "cancelled" }), chainRun({ conclusion: "cancelled" })],
      [chainRun({ conclusion: "cancelled" }), chainRun({ id: 88, path: ".github/workflows/other.yml", conclusion: "cancelled" })]] as const) {
      const reruns: number[] = [];
      const fake = fakePort({
        rerun: async (_repo, id) => { reruns.push(id); return { ok: true, value: undefined }; },
        runs: async () => ({ ok: true, value: [first, second] }),
        jobs: async () => ({ ok: true, value: [] }),
      });
      const rows = await awaitCiEvidence({
        ...input,
        checks: [first.id === 10 ? { name: "unit", cmd: "github-ci:unit" } : CHAIN, first.id === 10 ? CHAIN : { name: "other-ci", cmd: "github-ci:other.yml/build" }],
      }, { port: fake.port, ...fakeClock(), stopping: () => false });
      expect(reruns.sort()).toEqual([first.id, second.id].sort());
      expect(rows.every((r) => !r.ok)).toBe(true);
    }
  });

  test("a GitHub error reading the other workflow's jobs is never a pass", async () => {
    const port = fakePort({
      runs: async () => ({ ok: true, value: [chainRun({ conclusion: "success" })] }),
      jobs: async () => ({ ok: false, error: "boom" }),
    }).port;
    const row = await wait(port);
    expect(row.ok).toBe(false);
    expect(row.tail).toContain("reads failed in a row: boom");
  });
});

