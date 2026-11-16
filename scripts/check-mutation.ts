/**
 * @covers GATE-02
 */
// Wrapper around `spec-flow check-mutation` (spec-flow >= 0.4.0).
// Finché la 0.4.0 non è pubblicata su npm il comando non esiste nella versione installata:
// in quel caso il ratchet avvisa e non blocca, invece di tenere rossa ogni PR per un motivo
// che non dipende dalla PR. Appena il bump entra, il comando gira e torna bloccante da solo.
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
