/**
 * The rule that decides which heavy jobs of ci.yml a change reaches has its own
 * gate, and so does the wiring that obeys it.
 *
 * Three ways to be wrong, and only the first shows up as a red job:
 *   1. a job that should run is skipped (a regression nobody sees),
 *   2. a job that is skipped leaves a verdict the board reads as NOT MEASURED, and
 *      the pull request waits forever,
 *   3. a list that was true when it was written is false a month later.
 * So: the classification is a table, the lists are checked against the import
 * closure of the files each job runs (3), and the workflow is EVALUATED, step by
 * step, for each shape of change (1 and 2).
 *
 * @covers GATE-22
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Glob } from "bun";
import { join } from "node:path";
import {
  ALL_TAURI_SYSTEMS,
  E2E_INERT,
  OS_SENSITIVE_ENTRIES,
  PROCESS_GROUPS_TRIGGERS,
  TAURI_TRIGGERS,
  classify,
  judgeEvent,
  previousPushIsGreen,
  pullRequestFiles,
  pushFiles,
  renderOutputs,
  type Fetcher,
} from "./ci-changes.ts";
import { CI_CONFIG_PATH, readE2eEvidence, type GithubJob, type GithubRun } from "../server/services/ci-evidence.ts";

const ROOT = join(import.meta.dir, "..");

/**
 * What the macOS and Windows legs execute, as `scripts/ci-changes.ts --os-closure` prints it. A child
 * process on purpose: the preload of `bun test` changes how `Bun.build` resolves an extensionless import.
 */
const OS_CLOSURE: ReadonlySet<string> = (() => {
  const ran = spawnSync(process.execPath, ["run", "scripts/ci-changes.ts", "--os-closure"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  if (ran.status !== 0) throw new Error(`--os-closure failed (${ran.status}): ${ran.stderr}`);
  return new Set(ran.stdout.split("\n").filter(Boolean));
})();

const shape = (files: string[]) => {
  const v = classify(files, OS_CLOSURE);
  return { e2e: v.run.e2e, tauri: v.run.tauri, processGroups: v.run.processGroups, systems: v.tauriSystems.length };
};

describe("classify: what each kind of change reaches", () => {
  it("a change that only touches documents reaches no heavy job", () => {
    expect(shape(["docs/board-protocol.md"])).toEqual({ e2e: false, tauri: false, processGroups: false, systems: 0 });
    expect(shape(["openspec/specs/quality-gates/spec.md", "CHANGELOG.md", "docs/a/b.png"])).toEqual({ e2e: false, tauri: false, processGroups: false, systems: 0 });
    expect(shape(["landing/src/pages/index.astro", "LICENSE"])).toEqual({ e2e: false, tauri: false, processGroups: false, systems: 0 });
  });

  it("a client change reaches the e2e shards and nothing else", () => {
    expect(shape(["client/src/components/Sidebar/TopicItem.tsx"])).toEqual({ e2e: true, tauri: false, processGroups: false, systems: 0 });
    expect(shape(["tests/e2e/add-menu.spec.ts"])).toEqual({ e2e: true, tauri: false, processGroups: false, systems: 0 });
  });

  it("a server change reaches the shards and the Ubuntu leg of tauri, not the other systems", () => {
    expect(shape(["server/routes/tasks.ts"])).toEqual({ e2e: true, tauri: true, processGroups: true, systems: 1 });
    expect(classify(["shared/board.ts"], OS_CLOSURE).tauriSystems).toEqual(["ubuntu-latest"]);
  });

  it("a change to what only another system compiles or executes reaches all three systems", () => {
    for (const file of [
      "desktop-tauri/src-tauri/src/lib.rs",
      "desktop-tauri/pty-bridge/src/main.rs",
      "native/src/lib.rs",
      "server/sidecar-entry.ts",
      "scripts/build-server-sidecar.sh",
      "package.json",
      "bun.lock",
      ".bun-version",
      "public/sw.js",
      // cargo and rustup find these by walking up from any crate
      "rust-toolchain.toml",
      "rust-toolchain",
      ".cargo/config.toml",
      "Cargo.toml",
      // the parity walks this checkout and applies every .gitignore; the checkout is written by .gitattributes
      ".gitignore",
      "client/.gitignore",
      ".gitattributes",
    ]) {
      expect(classify([file], OS_CLOSURE).tauriSystems, file).toEqual([...ALL_TAURI_SYSTEMS]);
    }
  });

  it("the TypeScript the other systems EXECUTE with per-system branches reaches all three, whatever its name", () => {
    // Found by review: none of these was in the hand-written list, and only the macOS and Windows legs run them.
    for (const file of [
      "server/lib/protected-app-data.ts",
      "server/lib/git-porcelain.ts",
      "server/lib/git-numstat.ts",
      "server/lib/git-status.ts",
      "server/lib/native-addon.ts",
      "server/lib/file-tree.ts",
      "server/lib/gitignore.ts",
      "server/lib/path-containment.ts",
      "server/pty-bridge.mjs",
      "server/pty-bridge-platform.mjs",
    ]) {
      expect(OS_CLOSURE.has(file), `${file} is in the closure`).toBe(true);
      expect(classify([file], OS_CLOSURE).tauriSystems, file).toEqual([...ALL_TAURI_SYSTEMS]);
    }
  });

  it("without the closure every server and shared file counts as system-sensitive: a doubt runs everything", () => {
    expect(classify(["server/routes/tasks.ts"]).tauriSystems).toEqual([...ALL_TAURI_SYSTEMS]);
    expect(classify(["shared/board.ts"]).tauriSystems).toEqual([...ALL_TAURI_SYSTEMS]);
  });

  it("a Rust-only change does not wake the e2e shards: they never see the binary", () => {
    expect(shape(["desktop-tauri/src-tauri/src/lib.rs"])).toEqual({ e2e: false, tauri: true, processGroups: false, systems: 3 });
  });

  it("the workflow, and this file, re-judge everything", () => {
    expect(shape([".github/workflows/ci.yml"])).toEqual({ e2e: true, tauri: true, processGroups: true, systems: 3 });
    expect(shape(["scripts/ci-changes.ts"])).toEqual({ e2e: true, tauri: true, processGroups: true, systems: 3 });
    // another workflow is not read by any job of this one
    expect(shape([".github/workflows/e2e-nightly.yml"]).e2e).toBe(false);
  });

  it("one file that matters is enough, however many documents come with it", () => {
    expect(shape(["docs/a.md", "docs/b.md", "openspec/c.md", "client/src/x.ts"]).e2e).toBe(true);
    expect(shape(["docs/a.md", "server/x.ts"]).processGroups).toBe(true);
  });

  it("markdown is inert only at the root: elsewhere a fixture or a prompt that code reads", () => {
    expect(shape(["client/src/components/Board/__fixtures__/plan-comment.md"]).e2e).toBe(true);
    expect(shape(["server/providers/muse/WIRE.md"]).e2e).toBe(true);
    expect(shape(["tests/e2e/README.md"]).e2e).toBe(true);
  });

  it("a path nobody listed runs the shards: the denylist fails toward running", () => {
    expect(shape(["some-new-top-level-dir/file.ts"]).e2e).toBe(true);
    expect(shape(["relay/src/ponte.ts"]).e2e).toBe(true);
  });

  it("a path nobody listed does NOT run tauri or process-groups: that is what the closure test guards", () => {
    expect(shape(["some-new-top-level-dir/file.ts"])).toEqual({ e2e: true, tauri: false, processGroups: false, systems: 0 });
  });

  it("any doubt runs everything on every system", () => {
    expect(shape([])).toEqual({ e2e: true, tauri: true, processGroups: true, systems: 3 });
    expect(shape(["", "  "])).toEqual({ e2e: true, tauri: true, processGroups: true, systems: 3 });
  });

  it("tolerates a leading ./ and surrounding spaces", () => {
    expect(shape(["./docs/a.md", " docs/b.md "]).e2e).toBe(false);
  });

  it("renders the outputs the workflow reads, and the systems as JSON", () => {
    expect(renderOutputs(classify(["server/x.ts"], OS_CLOSURE))).toEqual(["e2e=true", "tauri=true", "process_groups=true", 'tauri_systems=["ubuntu-latest"]']);
    expect(renderOutputs(classify(["docs/x.md"], OS_CLOSURE))).toEqual(["e2e=false", "tauri=false", "process_groups=false", "tauri_systems=[]"]);
  });
});

/** A fake of the GitHub API: one reply per URL fragment, in order, and a log of what was asked. */
function fakeApi(replies: Array<{ match: string; ok?: boolean; body: unknown }>) {
  const asked: string[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push(url);
    const reply = replies.find((r) => url.includes(r.match));
    if (!reply) throw new Error(`unexpected request: ${url}`);
    return { ok: reply.ok ?? true, json: async () => reply.body };
  };
  return { fetcher, asked };
}

const page = (n: number, prefix = "client/f") => Array.from({ length: n }, (_, i) => ({ filename: `${prefix}${i}.ts` }));

describe("pullRequestFiles", () => {
  it("lists both sides of a rename: moving a file out of server/ changes the server", async () => {
    const { fetcher } = fakeApi([{ match: "/pulls/7/files", body: [{ filename: "docs/moved.ts", previous_filename: "server/lib/moved.ts" }] }]);
    expect(await pullRequestFiles("o/r", 7, "t", fetcher)).toEqual(["docs/moved.ts", "server/lib/moved.ts"]);
  });

  it("follows the pages until a short one", async () => {
    const { fetcher, asked } = fakeApi([
      { match: "&page=1", body: page(100) },
      { match: "&page=2", body: page(100) },
      { match: "&page=3", body: page(3) },
    ]);
    expect((await pullRequestFiles("o/r", 7, "t", fetcher))?.length).toBe(203);
    expect(asked).toHaveLength(3);
  });

  it("is null, never a short list, when GitHub fails or the list is longer than it can give", async () => {
    expect(await pullRequestFiles("o/r", 7, "t", fakeApi([{ match: "/pulls/", ok: false, body: {} }]).fetcher)).toBeNull();
    expect(await pullRequestFiles("o/r", 7, "t", fakeApi([{ match: "/pulls/", body: { message: "nope" } }]).fetcher)).toBeNull();
    expect(await pullRequestFiles("o/r", 7, "t", fakeApi([{ match: "/pulls/", body: page(100) }]).fetcher)).toBeNull();
  });
});

describe("pushFiles and previousPushIsGreen", () => {
  it("a compare that hit the 300-file cap is null: the rest of the files is unknown", async () => {
    expect(await pushFiles("o/r", "a", "b", "t", fakeApi([{ match: "/compare/a...b", body: { status: "ahead", files: page(300) } }]).fetcher)).toBeNull();
    expect(await pushFiles("o/r", "a", "b", "t", fakeApi([{ match: "/compare/a...b", body: { status: "ahead", files: page(299) } }]).fetcher)).toHaveLength(299);
  });

  it("only an `ahead` compare lists the files since `before`: a diverged or behind one lists them from the merge base", async () => {
    // Measured on the real API: diverged commits answered 4 files where the two trees differ by 101.
    for (const status of ["diverged", "behind", "identical", undefined]) {
      const compare = fakeApi([{ match: "/compare/a...b", body: { status, files: [{ filename: "docs/only.md" }] } }]);
      expect(await pushFiles("o/r", "a", "b", "t", compare.fetcher), String(status)).toBeNull();
    }
  });

  it("is green only for a completed push run of main that concluded success", async () => {
    const run = (over: Record<string, unknown>) => ({ event: "push", head_branch: "main", conclusion: "success", ...over });
    const asks = (runs: unknown[], ok = true) => previousPushIsGreen("o/r", "abc", "t", fakeApi([{ match: "head_sha=abc", ok, body: { workflow_runs: runs } }]).fetcher);
    expect(await asks([run({})])).toBe(true);
    expect(await asks([run({ conclusion: "failure" }), run({})])).toBe(true);
    expect(await asks([run({ conclusion: "failure" })])).toBe(false);
    expect(await asks([run({ conclusion: null })])).toBe(false);
    expect(await asks([run({ conclusion: "cancelled" })])).toBe(false);
    // a pull request run of the same sha judged a merge commit, not this tree
    expect(await asks([run({ event: "pull_request" })])).toBe(false);
    expect(await asks([run({ head_branch: "topics/x" })])).toBe(false);
    expect(await asks([])).toBe(false);
    expect(await asks([run({})], false)).toBe(false);
  });
});

describe("judgeEvent: the answer for a real event, and every way it can fail", () => {
  const base = { repo: "o/r", token: "t" };
  const everything = (v: ReturnType<typeof classify>) => v.run.e2e && v.run.tauri && v.run.processGroups && v.tauriSystems.length === 3;

  it("a pull request is judged by its own files", async () => {
    const { fetcher } = fakeApi([{ match: "/pulls/9/files", body: [{ filename: "docs/a.md" }] }]);
    const v = await judgeEvent({ ...base, event: "pull_request", payload: { pull_request: { number: 9 } } }, fetcher);
    expect(v.run).toEqual({ e2e: false, tauri: false, processGroups: false });
  });

  it("a push is judged by its diff only when the previous commit of main is green", async () => {
    const payload = { before: "bbb", after: "aaa" };
    const green = fakeApi([
      { match: "head_sha=bbb", body: { workflow_runs: [{ event: "push", head_branch: "main", conclusion: "success" }] } },
      { match: "/compare/bbb...aaa", body: { status: "ahead", files: [{ filename: "docs/a.md" }] } },
    ]);
    expect((await judgeEvent({ ...base, event: "push", payload }, green.fetcher)).run.e2e).toBe(false);

    const red = fakeApi([
      { match: "head_sha=bbb", body: { workflow_runs: [{ event: "push", head_branch: "main", conclusion: "failure" }] } },
      { match: "/compare/bbb...aaa", body: { status: "ahead", files: [{ filename: "docs/a.md" }] } },
    ]);
    const v = await judgeEvent({ ...base, event: "push", payload }, red.fetcher);
    expect(everything(v)).toBe(true);
    expect(v.why.e2e).toContain("no green push run");
    // the diff is not even asked for: the answer does not depend on it
    expect(red.asked.some((u) => u.includes("/compare/"))).toBe(false);
  });

  it("a force push and a diverged compare run everything, even after a green commit", async () => {
    const green = { match: "head_sha=bbb", body: { workflow_runs: [{ event: "push", head_branch: "main", conclusion: "success" }] } };
    const docsOnly = { match: "/compare/bbb...aaa", body: { status: "diverged", files: [{ filename: "docs/a.md" }] } };
    const diverged = fakeApi([green, docsOnly]);
    const v = await judgeEvent({ ...base, event: "push", payload: { before: "bbb", after: "aaa" } }, diverged.fetcher);
    expect(everything(v)).toBe(true);
    // a force push is refused before any request: the answer does not depend on what GitHub says
    const forced = fakeApi([green, docsOnly]);
    const f = await judgeEvent({ ...base, event: "push", payload: { before: "bbb", after: "aaa", forced: true } }, forced.fetcher);
    expect(everything(f)).toBe(true);
    expect(forced.asked).toEqual([]);
  });

  it("everything runs when there is nothing to judge by", async () => {
    const dead: Fetcher = async () => {
      throw new Error("network down");
    };
    const pr = { ...base, event: "pull_request", payload: { pull_request: { number: 9 } } };
    expect(everything(await judgeEvent(pr, dead))).toBe(true);
    expect(everything(await judgeEvent({ ...pr, token: "" }, dead))).toBe(true);
    expect(everything(await judgeEvent({ ...pr, repo: "" }, dead))).toBe(true);
    expect(everything(await judgeEvent({ ...pr, payload: {} }, dead))).toBe(true);
    expect(everything(await judgeEvent({ ...base, event: "push", payload: { before: "0000000000000000000000000000000000000000", after: "a" } }, dead))).toBe(true);
    expect(everything(await judgeEvent({ ...base, event: "push", payload: { after: "a" } }, dead))).toBe(true);
    expect(everything(await judgeEvent({ ...base, event: "workflow_dispatch", payload: {} }, dead))).toBe(true);
    expect(everything(await judgeEvent({ ...base, event: undefined, payload: {} }, dead))).toBe(true);
  });
});

describe("the lists against the import closure of what each job runs", () => {
  /**
   * Every repo file the entries import, node_modules left out.
   *
   * In a child process on purpose: the preload of `bun test` registers a runtime
   * plugin (tests/setup/bun-test-preload.ts) that changes how `Bun.build` resolves
   * an extensionless import, and the answer must be the one a plain `bun` gives.
   */
  function closure(entries: string[]): string[] {
    const code = `
      const built = await Bun.build({
        entrypoints: process.argv.slice(1).map((e) => process.cwd() + "/" + e),
        target: "bun", write: false, packages: "external", metafile: true,
        // The client imports assets Vite understands and Bun has to be told about.
        loader: { ".svg": "file", ".png": "file", ".css": "file", ".md": "text", ".sql": "text", ".html": "text", ".json": "json" },
      });
      if (!built.success) { console.error(built.logs.map(String).join("\\n")); process.exit(1); }
      console.log(JSON.stringify(Object.keys(built.metafile.inputs)));
    `;
    const ran = spawnSync(process.execPath, ["-e", code, "--", ...entries], { cwd: ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (ran.status !== 0) throw new Error(`closure of ${entries.length} entries did not build (${ran.status}):\n${ran.stderr}`);
    const inputs = JSON.parse(ran.stdout) as string[];
    return inputs.map((f) => (f.startsWith("/") ? f.slice(ROOT.length + 1) : f));
  }

  const missing = (files: string[], patterns: readonly RegExp[]) => files.filter((f) => !patterns.some((re) => re.test(f)));

  it("process-groups: every file the four tests import is a trigger", () => {
    const files = closure([
      "server/lib/command-process-groups.test.ts",
      "server/lib/command-process.test.ts",
      "server/routes/processes.command.test.ts",
      "server/routes/tasks.process-groups.test.ts",
      "tests/setup/bun-test-preload.ts",
    ]);
    expect(files.length).toBeGreaterThan(100);
    // a file listed here is an input the job has and scripts/ci-changes.ts does not know
    expect(missing(files, PROCESS_GROUPS_TRIGGERS)).toEqual([]);
  });

  it("tauri: every file the sidecar and the tests of the job import is a trigger", () => {
    const files = closure([
      "server/sidecar-entry.ts",
      "tests/tauri-shell/channel-throw.test.ts",
      ...OS_SENSITIVE_ENTRIES,
      "tests/setup/bun-test-preload.ts",
    ]);
    expect(files.length).toBeGreaterThan(100);
    expect(missing(files, TAURI_TRIGGERS)).toEqual([]);
  });

  it("the system-sensitive closure is real: its entries exist and it reaches the files review found", () => {
    for (const entry of OS_SENSITIVE_ENTRIES) {
      expect(existsSync(join(ROOT, entry)), `${entry} exists`).toBe(true);
      expect(OS_CLOSURE.has(entry), `${entry} is in its own closure`).toBe(true);
    }
    // A closure that quietly shrank to the entries would put every server file back on Ubuntu only.
    expect(OS_CLOSURE.size).toBeGreaterThan(30);
    // Every file of it is inside the directories the `changes` job checks out (ci.yml, sparse-checkout).
    const outside = [...OS_CLOSURE].filter((f) => !/^(native|scripts|server|shared|tests)\//.test(f) && f.includes("/"));
    expect(outside).toEqual([]);
  });

  it("e2e: nothing a spec, the server or the client imports lives in a place declared inert", () => {
    const specs = [...new Glob("tests/e2e/**/*.ts").scanSync(ROOT)];
    const files = closure([...specs, "server.ts", "client/src/main.tsx", "playwright.config.ts"]);
    expect(files.length).toBeGreaterThan(1000);
    const inert = files.filter((f) => E2E_INERT.some((re) => re.test(f)));
    expect(inert).toEqual([]);
  });
});

describe("ci.yml obeys the answer: the workflow is evaluated, not read", () => {
  type Step = { name?: string; uses?: string; if?: string };
  type Job = { needs?: string | string[]; if?: string; strategy?: { matrix?: Record<string, string | string[]> }; steps?: Step[] };
  const doc = (Bun as unknown as { YAML: { parse(text: string): { jobs: Record<string, Job> } } }).YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
  const jobs = doc.jobs;

  const E2E_FAMILY = new Set(["prepare-e2e", "e2e"]);
  const truthyResult = (v: unknown) => !(v === "" || v === 0 || v === false || v === null || v === undefined);

  type Answer = { e2e: string; tauri: string; process_groups: string; tauri_systems: string };
  const answerOf = (files: string[]): Answer => {
    const v = classify(files, OS_CLOSURE);
    return {
      e2e: String(v.run.e2e),
      tauri: String(v.run.tauri),
      process_groups: String(v.run.processGroups),
      tauri_systems: JSON.stringify(v.tauriSystems),
    };
  };

  type Ctx = { answer: Answer; event: string; shard?: number };

  /** The value of a dotted name, for the few contexts ci.yml reads in the e2e family. Anything else throws. */
  function lookup(path: string, ctx: Ctx): unknown {
    const changes = /^needs\.changes\.outputs\.(\w+)$/.exec(path);
    if (changes) return (ctx.answer as Record<string, string>)[changes[1]!] ?? "";
    if (path === "needs.prepare-e2e.outputs.plan-ok") return "";
    if (/^steps\.\w+\.outputs\.\w+$/.test(path)) return "";
    if (path === "github.event_name") return ctx.event;
    if (path === "matrix.shard") return ctx.shard;
    throw new Error(`the evaluator does not know the context "${path}": teach it here, do not skip the step`);
  }

  /**
   * Evaluates the small expression language ci.yml uses in `if:` and in a matrix:
   * `&&` `||` `!` `==` `!=`, strings, numbers, parentheses, `fromJSON`, and the status
   * functions. `&&` and `||` return an operand, as GitHub's do. A name it cannot
   * resolve throws, so a new step cannot slip past unevaluated.
   */
  function evaluate(expression: string, ctx: Ctx): unknown {
    const text = expression.replace(/^\s*\$\{\{\s*/, "").replace(/\s*\}\}\s*$/, "");
    const tokens = text.match(/'(?:[^']|'')*'|&&|\|\||==|!=|[!(),]|\d+|[\w.-]+/g) ?? [];
    let at = 0;
    const peek = () => tokens[at];
    const take = () => tokens[at++]!;
    const truthy = (v: unknown) => !(v === "" || v === 0 || v === false || v === null || v === undefined);

    const primary = (): unknown => {
      const token = take();
      if (token === "(") {
        const inner = or();
        if (take() !== ")") throw new Error(`unbalanced parentheses in: ${text}`);
        return inner;
      }
      if (token.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
      if (/^\d+$/.test(token)) return Number(token);
      if (peek() === "(") {
        take();
        const args: unknown[] = [];
        while (peek() !== ")") {
          args.push(or());
          if (peek() === ",") take();
        }
        take();
        if (token === "always" || token === "success") return true;
        if (token === "cancelled" || token === "failure") return false;
        if (token === "fromJSON") return JSON.parse(String(args[0]));
        throw new Error(`the evaluator does not know the function ${token}()`);
      }
      return lookup(token, ctx);
    };
    const unary = (): unknown => (peek() === "!" ? (take(), !truthy(unary())) : primary());
    const equality = (): unknown => {
      const left = unary();
      if (peek() !== "==" && peek() !== "!=") return left;
      const op = take();
      const right = unary();
      const same = String(left).toLowerCase() === String(right).toLowerCase();
      return op === "==" ? same : !same;
    };
    const and = (): unknown => {
      let value = equality();
      while (peek() === "&&") {
        take();
        const right = equality();
        value = truthy(value) ? right : value;
      }
      return value;
    };
    const or = (): unknown => {
      let value = and();
      while (peek() === "||") {
        take();
        const right = and();
        value = truthy(value) ? value : right;
      }
      return value;
    };
    const result = or();
    if (at !== tokens.length) throw new Error(`unparsed tail "${tokens.slice(at).join(" ")}" in: ${text}`);
    return result;
  }

  /** The jobs that start, the matrix legs they get, and for the e2e family the steps that run in each leg. */
  function plan(answer: Answer, event: string) {
    const out: Record<string, Array<{ leg: string; steps: string[] }>> = {};
    for (const [name, job] of Object.entries(jobs)) {
      if (job.if && !truthyResult(evaluate(job.if, { answer, event }))) continue;
      const matrix = job.strategy?.matrix ?? {};
      const [key, spec] = Object.entries(matrix)[0] ?? [];
      const legs: Array<string | number> = !key ? [""] : Array.isArray(spec) ? spec : (evaluate(spec, { answer, event }) as Array<string | number>);
      out[name] = legs.map((leg) => ({
        leg: String(leg),
        steps: E2E_FAMILY.has(name)
          ? (job.steps ?? [])
              .filter((st) => !st.if || truthyResult(evaluate(st.if, { answer, event, shard: typeof leg === "number" ? leg : undefined })))
              .map((st) => st.name ?? st.uses ?? "?")
          : [],
      }));
    }
    return out;
  }

  const EXEMPT = "Nothing the e2e shards read has changed";

  it("only unit, gates, check and changes never wait for a path", () => {
    const needsOf = (j: Job) => [j.needs ?? []].flat();
    expect(needsOf(jobs.unit!)).toEqual([]);
    expect(needsOf(jobs.gates!)).toEqual([]);
    expect(needsOf(jobs.check!).sort()).toEqual(["gates", "unit"]);
    expect(needsOf(jobs.changes!)).toEqual([]);
    for (const name of ["prepare-e2e", "e2e", "process-groups", "tauri"]) expect(needsOf(jobs[name]!), name).toContain("changes");
  });

  it("a documents-only pull request: no heavy step runs, and the two jobs the board reads still end success", () => {
    const run = plan(answerOf(["docs/board-protocol.md"]), "pull_request");
    expect(Object.keys(run).sort()).toEqual(["changes", "check", "e2e", "gates", "prepare-e2e", "unit"]);
    expect(run["prepare-e2e"]).toEqual([{ leg: "", steps: [EXEMPT] }]);
    // ONE leg named `e2e (0)`: the board matches /^e2e( \(\d+\))?$/ and wants every one of them success
    expect(run.e2e).toEqual([{ leg: "0", steps: [EXEMPT] }]);
    expect(run["process-groups"]).toBeUndefined();
    expect(run.tauri).toBeUndefined();
  });

  it("the same on a push to main: one job, only the notice", () => {
    const run = plan(answerOf(["docs/x.md"]), "push");
    expect(run.e2e).toEqual([{ leg: "0", steps: [EXEMPT] }]);
  });

  it("a client change: nine e2e legs with their steps, the exempt step nowhere, no tauri, no process-groups", () => {
    const run = plan(answerOf(["client/src/App.tsx"]), "pull_request");
    expect(run.e2e!.map((l) => l.leg)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
    for (const leg of run.e2e!) expect(leg.steps).not.toContain(EXEMPT);
    expect(run.e2e![0]!.steps).toContain("E2E dei file toccati, anche fuori dal tier PR");
    expect(run.e2e![0]!.steps).not.toContain("Run E2E tests (Playwright)");
    expect(run.e2e![3]!.steps).toContain("Run E2E tests (Playwright)");
    expect(run["prepare-e2e"]![0]!.steps).toContain("Calcola il piano di sharding per durata");
    expect(run["prepare-e2e"]![0]!.steps).not.toContain(EXEMPT);
    expect(run["process-groups"]).toBeUndefined();
    expect(run.tauri).toBeUndefined();
  });

  it("a push to main keeps its eight shards, and no `e2e (0)`", () => {
    const run = plan(answerOf(["client/src/App.tsx"]), "push");
    expect(run.e2e!.map((l) => l.leg)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("a server change: process-groups on both systems, tauri on Ubuntu only", () => {
    const run = plan(answerOf(["server/routes/tasks.ts"]), "pull_request");
    expect(run["process-groups"]!.length).toBe(2);
    expect(run.tauri!.map((l) => l.leg)).toEqual(["ubuntu-latest"]);
  });

  it("a Rust change: tauri on the three systems, and not a single e2e step", () => {
    const run = plan(answerOf(["desktop-tauri/src-tauri/src/lib.rs"]), "pull_request");
    expect(run.tauri!.map((l) => l.leg)).toEqual(["macos-latest", "windows-latest", "ubuntu-latest"]);
    expect(run.e2e).toEqual([{ leg: "0", steps: [EXEMPT] }]);
  });

  it("a `changes` that answers nothing runs everything, as before this change", () => {
    const silent = { e2e: "", tauri: "", process_groups: "", tauri_systems: "" };
    const run = plan(silent, "pull_request");
    expect(run["process-groups"]).toBeDefined();
    expect(run.tauri!.map((l) => l.leg)).toEqual(["macos-latest", "windows-latest", "ubuntu-latest"]);
    expect(run.e2e!.length).toBe(9);
    for (const leg of run.e2e!) expect(leg.steps).not.toContain(EXEMPT);
  });

  it("the board reads the e2e row of a documents-only pull request as pass, and would read a skipped job as NOT MEASURED", () => {
    const sha = "a".repeat(40);
    const run: GithubRun = { id: 1, head_sha: sha, event: "pull_request", path: CI_CONFIG_PATH, status: "completed", conclusion: "success", html_url: "https://example.test/run/1" };
    const finished = (name: string, conclusion: string): GithubJob => ({ id: 1, name, status: "completed", conclusion });

    // The jobs GitHub would report: every planned job ends `success` (a step skipped inside it does not change that).
    const planned = plan(answerOf(["docs/board-protocol.md"]), "pull_request");
    const jobsOf = (conclusion: (job: string) => string) =>
      Object.entries(planned).flatMap(([name, legs]) => legs.map((l) => finished(name === "e2e" ? `e2e (${l.leg})` : name, conclusion(name))));

    expect(readE2eEvidence(sha, [run], jobsOf(() => "success")).kind).toBe("pass");

    // The shape this design avoids: the same run with the e2e job skipped by an `if:` on the job.
    const skipped = readE2eEvidence(sha, [run], jobsOf((job) => (job === "e2e" ? "skipped" : "success")));
    expect(skipped.kind).toBe("notMeasured");
  });

  it("no step of the e2e family runs when the answer is `false`, whatever it is called", () => {
    // The property the board depends on: a step added tomorrow without the gate is red here.
    const exempt = answerOf(["docs/x.md"]);
    for (const name of ["prepare-e2e", "e2e"]) {
      for (const event of ["pull_request", "push"]) {
        const legs = plan(exempt, event)[name]!;
        for (const leg of legs) expect(leg.steps, `${name} on ${event}`).toEqual([EXEMPT]);
      }
    }
  });
});
