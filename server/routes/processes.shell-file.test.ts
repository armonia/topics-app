/**
 * A background shell of the CURRENT CLI: the id the agent sees finds the row,
 * and the row's log grows from the file the CLI writes, without the agent
 * reading anything. The announcement is the CLI's own text (BGSHELL-05).
 *
 * @covers BGSHELL-05
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { classifyShellToolResult } from "../providers/claude/background-shell";
import { closeBackgroundShell, createProcessesRouter, listBackgroundShells, noteBackgroundShellOutput, registerBackgroundShell } from "./processes";

const DIR = realpathSync(mkdtempSync(join(tmpdir(), "topics-shell-file-")));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let n = 0;
/** The shell as the chat route registers it from the CLI's answer. */
function startShell(shellId: string) {
  const sessionKey = `shell-file-session-${++n}`;
  const outputPath = join(DIR, `${shellId}.output`);
  writeFileSync(outputPath, "");
  const announcement = `Command running in background with ID: ${shellId}. Output is being written to: ${outputPath}. If it exits while you are still working you will be notified.`;
  const action = classifyShellToolResult({ type: "shell", command: "sleep 60", background: true } as never, announcement);
  if (action?.kind !== "start") throw new Error("not a start");
  registerBackgroundShell({
    sessionKey, topicId: "t", shellId: action.shellId, outputPath: action.outputPath,
    command: action.command, cwd: DIR, ownerPid: null,
  });
  return { sessionKey, outputPath };
}
const shellOf = (sessionKey: string) => listBackgroundShells().find((s) => s.sessionKey === sessionKey);

async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(100);
}

describe("the CLI's own announcement", () => {
  test("wait_for_process on the id the agent sees finds the shell", async () => {
    const { sessionKey } = startShell("b68urh4wy");
    const router = createProcessesRouter({
      db: { query: () => ({ get: () => null }) },
      json: (d: unknown, status = 200) => new Response(JSON.stringify(d), { status }),
      broadcastToAll: () => {},
      getTopicBySessionKey: (k: string) => (k === sessionKey ? { id: "t", sessionKey } : null),
      resolveTopicCwd: () => DIR,
    } as never);
    const url = new URL(`http://x/api/sessions/${sessionKey}/scripts/b68urh4wy/wait?timeout_ms=1000`);
    const resp = (await router(new Request(url), url, url.pathname, "GET"))!;
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ reason: "timeout", status: "running" });
    closeBackgroundShell(sessionKey, "b68urh4wy", "killed");
  });

  test("the row's log grows from the file, with no BashOutput", async () => {
    const { sessionKey, outputPath } = startShell("bfile0001");
    appendFileSync(outputPath, "first line\n");
    await until(() => shellOf(sessionKey)!.output.join("\n").includes("first line"));
    expect(shellOf(sessionKey)!.output.join("\n")).toContain("first line");

    appendFileSync(outputPath, "second line\n");
    await until(() => shellOf(sessionKey)!.output.join("\n").includes("second line"));
    expect(shellOf(sessionKey)!.output.join("\n")).toContain("second line");

    // A `BashOutput` read of the same bytes does not print them twice.
    noteBackgroundShellOutput(sessionKey, "bfile0001", { output: "first line\nsecond line" });
    expect(shellOf(sessionKey)!.output.filter((l) => l === "first line")).toHaveLength(1);

    // What it wrote right before closing is in the log too.
    appendFileSync(outputPath, "last words\n");
    closeBackgroundShell(sessionKey, "bfile0001", "completed", 0);
    expect(shellOf(sessionKey)!.output.join("\n")).toContain("last words");
  });
});
