/**
 * WHAT A CONFIRMED DEPLOY WRITES ON THE CARD, for each way the command can end.
 *
 * `runDeploy` launches the board's command with a deadline and turns the outcome
 * into the card's state plus a system comment: the exit code, and the tail of
 * stderr (or of stdout when stderr is empty). A deadline reads as exit 124, a
 * command that cannot start (its checkout is gone) names the error instead of
 * an exit code, and a command killed from elsewhere keeps Bun's 128 + n.
 * Fixed here before the launch moved to `runBounded`.
 * @covers GIT-DEADLINE-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTasksRouter } from "./tasks";
import { projectIdForPath } from "../services/tasks";
import { call, freshDb, makeCtx } from "./tasks-test-support";

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-outcome-"));
  process.env.TOPICS_SPAWN_TIMEOUT_CAP_MS = "300";
});
afterAll(() => {
  delete process.env.TOPICS_SPAWN_TIMEOUT_CAP_MS;
  rmSync(root, { recursive: true, force: true });
});

/** Proposes `command` on a fresh card, confirms it, waits for the outcome. */
async function deploy(command: string, cwd: string): Promise<{ state: string; comment: string }> {
  const db: Database = freshDb();
  const projectId = projectIdForPath(cwd);
  const router = createTasksRouter(makeCtx(db, []), undefined, { listProjectDirs: () => [cwd] });
  const t = await (await call(router, "POST", `/api/boards/${projectId}/tasks`, { text: "deploy" }))!.json();
  db.prepare("UPDATE tasks SET deploy_state = 'proposed', deploy_command_at_propose = ? WHERE id = ?").run(command, t.id);
  const res = (await call(router, "POST", `/api/boards/${projectId}/tasks/${t.id}/deploy`, {}))!;
  expect(res.status).toBe(202);
  const deadline = Date.now() + 10_000;
  let state = "running";
  while (state === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    state = (db.prepare("SELECT deploy_state FROM tasks WHERE id = ?").get(t.id) as { deploy_state: string }).deploy_state;
  }
  const row = db.prepare("SELECT content FROM task_comments WHERE task_id = ? AND author = 'system' ORDER BY rowid DESC LIMIT 1").get(t.id) as { content: string } | null;
  return { state, comment: row?.content ?? "" };
}

const fence = (body: string) => `\n\n\`\`\`\n${body}\n\`\`\``;

describe("runDeploy: the outcome on the card", () => {
  test("success: deployed, exit 0, stderr's tail first", async () => {
    const cmd = "printf out; printf err >&2";
    expect(await deploy(cmd, root)).toEqual({ state: "deployed", comment: `Deploy eseguito.\n\n\`${cmd}\` (exit 0)${fence("err")}` });
  });

  test("non-zero exit: failed, the code, stdout when stderr is empty", async () => {
    const cmd = "printf out; exit 3";
    expect(await deploy(cmd, root)).toEqual({ state: "failed", comment: `Deploy fallito.\n\n\`${cmd}\` (exit 3)${fence("out")}` });
  });

  test("deadline: failed, exit 124, what arrived before it", async () => {
    const cmd = "printf partial; exec sleep 30";
    expect(await deploy(cmd, root)).toEqual({ state: "failed", comment: `Deploy fallito.\n\n\`${cmd}\` (exit 124)${fence("partial")}` });
  });

  test("did not start (the checkout is gone): failed, the error instead of an exit code", async () => {
    const gone = join(root, "gone");
    const out = await deploy("true", gone);
    expect(out.state).toBe("failed");
    expect(out.comment.startsWith("Deploy fallito.\n\n`true`: ")).toBe(true);
    expect(out.comment).not.toContain("(exit");
    let expected = "";
    try { Bun.spawn(["bash", "-lc", "true"], { cwd: gone }); } catch (e) { expected = e instanceof Error ? e.message : String(e); }
    expect(expected).not.toBe("");
    expect(out.comment).toBe(`Deploy fallito.\n\n\`true\`: ${expected}`);
  });

  test("killed by a signal from elsewhere: failed, Bun's 128 + n", async () => {
    const cmd = "printf out; kill -9 $$";
    expect(await deploy(cmd, root)).toEqual({ state: "failed", comment: `Deploy fallito.\n\n\`${cmd}\` (exit 137)${fence("out")}` });
  });
});
