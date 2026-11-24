/**
 * What the two judge-driven measurement scripts (effort-variance, prompt-ab)
 * share: one headless Claude call that returns a verdict, and the agreement
 * math over repeated verdicts.
 */
import { spawn } from "node:child_process";
import { buildClaudeOneshotArgs } from "../server/providers/claude/args";

export const JUDGE_MODEL = "claude-haiku-4-5";

export function judge(prompt: string): Promise<string> {
  const args = buildClaudeOneshotArgs({ permissionMode: "bypassPermissions", model: JUDGE_MODEL, emptyMcpConfigPath: null });
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
      try { resolve(String(JSON.parse(out).result ?? "")); } catch { resolve(out); }
    });
    proc.stdin.end(prompt);
  });
}

/**
 * Disagreement rate: the probability that two independent draws from the
 * observed distribution give different verdicts (0 = always the same). Uses
 * the unbiased estimate, without replacement: 1 - sum(n_i (n_i - 1)) / N (N - 1).
 */
export function disagreement(labels: string[]): number {
  const n = labels.length;
  if (n < 2) return 0;
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  let same = 0;
  for (const c of counts.values()) same += c * (c - 1);
  return 1 - same / (n * (n - 1));
}

export function tally(labels: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of labels) out[l] = (out[l] ?? 0) + 1;
  return out;
}
