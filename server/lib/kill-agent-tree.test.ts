/**
 * Stopping a card kills the WHOLE process tree its agent spawned, not just
 * the turn — and it never touches a sibling session's tree.
 *
 * @covers KANBAN-07
 */
import { describe, it, expect, afterEach } from "bun:test";
import { setSessionCliPid, clearSessionCliPid } from "../providers/session-pids";
import { killAgentProcessTree } from "./kill-agent-tree";

// Real processes, on purpose: the whole point of card 9b36ea1b is that a
// SIGINT to the CLI does not reach what its `Bash` tool spawned. A mocked
// process tree would let that exact bug hide again.

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (isAlive(pid)) {
    if (Date.now() - start > timeoutMs) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 50));
  }
}

const spawned: number[] = [];
function spawnSleeper(): number {
  // `bash -c 'sleep N & sleep N & wait'`: the bash process (the stand-in for
  // an agent's CLI) has TWO real child processes, not just itself — this is
  // what proves a whole TREE dies, not only its root.
  const proc = Bun.spawn(["bash", "-c", "sleep 30 & sleep 30 & wait"], { stdout: "ignore", stderr: "ignore" });
  spawned.push(proc.pid);
  return proc.pid;
}

afterEach(() => {
  clearSessionCliPid("test:kill-agent-tree");
  clearSessionCliPid("test:kill-agent-tree-other");
  for (const pid of spawned.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

describe("killAgentProcessTree", () => {
  it("kills a sleeping child left running by a stopped card", async () => {
    const cliPid = spawnSleeper();
    setSessionCliPid("test:kill-agent-tree", cliPid);
    // Give bash a moment to actually fork its two `sleep` children.
    await new Promise(r => setTimeout(r, 200));

    await killAgentProcessTree("test:kill-agent-tree");

    await waitUntilDead(cliPid);
  });

  it("does not touch a sibling session's tree", async () => {
    const targetPid = spawnSleeper();
    const otherPid = spawnSleeper();
    setSessionCliPid("test:kill-agent-tree", targetPid);
    setSessionCliPid("test:kill-agent-tree-other", otherPid);
    await new Promise(r => setTimeout(r, 200));

    await killAgentProcessTree("test:kill-agent-tree");
    await waitUntilDead(targetPid);

    // The other "card"'s agent is untouched: stopping one never spills onto another.
    expect(isAlive(otherPid)).toBe(true);
  });

  it("is a no-op when the session has no registered CLI pid", async () => {
    await expect(killAgentProcessTree("test:kill-agent-tree-unknown")).resolves.toBeUndefined();
  });
});
