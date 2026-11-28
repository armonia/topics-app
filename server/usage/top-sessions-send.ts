/**
 * Writes one message into a listed session by resuming it headless with the
 * Claude CLI (`claude --resume <id> -p <text>`), the same way a person would
 * from a terminal. Argument array, no shell. `TOPICS_CLAUDE_BIN` overrides the
 * binary; the reply is not awaited, the transcript is where it lands.
 *
 * A session written to in the last minutes is open somewhere (a terminal, the
 * app): resuming it would put a second writer next to the first, so the send
 * is refused and the person is told to write in the open session. The process
 * has a deadline, so a stuck turn cannot live forever.
 */
import { spawn } from "node:child_process";
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";

/** A transcript written more recently than this belongs to a live session. */
export const LIVE_SESSION_MS = 5 * 60_000;
/** The longest a headless resumed turn may run. */
export const SEND_TIMEOUT_MS = 30 * 60_000;

export interface SendResult { ok: boolean; error?: string; live?: boolean }

async function lastWriteMs(root: string, sessionId: string): Promise<number | null> {
  try {
    for await (const d of await opendir(root)) {
      try { return (await stat(join(root, d.name, `${sessionId}.jsonl`))).mtimeMs; } catch { /* not in this folder */ }
    }
  } catch { /* no transcript folder */ }
  return null;
}

export async function sendToSession(sessionId: string, cwd: string | null, text: string, opts: { root: string; now?: number }): Promise<SendResult> {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) return { ok: false, error: "invalid session id" };
  const last = await lastWriteMs(opts.root, sessionId);
  if (last !== null && (opts.now ?? Date.now()) - last < LIVE_SESSION_MS) {
    return { ok: false, live: true, error: "This session is open right now: write in the open session instead of resuming it a second time." };
  }
  return new Promise((resolve) => {
    const child = spawn(process.env.TOPICS_CLAUDE_BIN || "claude", ["--resume", sessionId, "-p", text], { cwd: cwd ?? undefined, detached: true, stdio: "ignore", timeout: SEND_TIMEOUT_MS });
    child.once("error", (e) => resolve({ ok: false, error: e.message }));
    child.once("spawn", () => { child.unref(); resolve({ ok: true }); });
  });
}
