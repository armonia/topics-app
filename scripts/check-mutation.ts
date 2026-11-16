/**
 * @covers GATE-02
 */
// Wrapper around `spec-flow check-mutation` (spec-flow >= 0.4.0).
// Until 0.4.0 is on npm the installed version has no such command: the ratchet warns and
// passes instead of keeping every PR red for a reason the PR cannot fix. Once the bump lands
// the command exists and the ratchet blocks again by itself.
import { spawnSync } from "node:child_process";

const BIN = "spec-flow";

export function hasCheckMutation(help: string): boolean {
  return /^\s*check-mutation\b/m.test(help);
}

export function main(args: string[], run = spawnSync): number {
  const help = run(BIN, ["--help"], { encoding: "utf8" });
  const text = `${help.stdout ?? ""}${help.stderr ?? ""}`;
  if (!hasCheckMutation(text)) {
    console.log(
      "::warning::spec-flow installato non ha check-mutation (serve >= 0.4.0): ratchet saltato, non bloccante finché il bump non entra.",
    );
    return 0;
  }
  const res = run(BIN, ["check-mutation", ...args], { stdio: "inherit" });
  return res.status ?? 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
