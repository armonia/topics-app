/**
 * Writes one message into a listed session by resuming it headless with the
 * Claude CLI (`claude --resume <id> -p <text>`), the same way a person would
 * from a terminal. Argument array, no shell. `TOPICS_CLAUDE_BIN` overrides the
 * binary; the reply is not awaited, the transcript is where it lands.
 */
import { spawn } from "node:child_process";

export async function sendToSession(sessionId: string, cwd: string | null, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) return { ok: false, error: "invalid session id" };
  return new Promise((resolve) => {
    const child = spawn(process.env.TOPICS_CLAUDE_BIN || "claude", ["--resume", sessionId, "-p", text], { cwd: cwd ?? undefined, detached: true, stdio: "ignore" });
    child.once("error", (e) => resolve({ ok: false, error: e.message }));
    child.once("spawn", () => { child.unref(); resolve({ ok: true }); });
  });
}
