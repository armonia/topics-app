export interface GitStatusEnvelope {
  type?: unknown;
  projectPath?: unknown;
  status?: { files?: unknown } | null;
}

export function percentile95(samples: number[]): number {
  if (samples.length === 0) throw new Error("p95 requires at least one sample");
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

export function median(samples: number[]): number {
  if (samples.length === 0) throw new Error("median requires at least one sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function isMatchingGitStatus(
  message: unknown,
  projectPath: string,
  filePath: string,
): boolean {
  if (!message || typeof message !== "object") return false;
  const envelope = message as GitStatusEnvelope;
  if (envelope.type !== "git:status" || envelope.projectPath !== projectPath) return false;
  if (!envelope.status || !Array.isArray(envelope.status.files)) return false;
  return envelope.status.files.some((file) =>
    Boolean(file && typeof file === "object" && (file as { path?: unknown }).path === filePath),
  );
}

export function freshnessExitCode(p95Ms: number, budgetMs: number): number {
  return p95Ms <= budgetMs ? 0 : 1;
}
