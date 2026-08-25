/**
 * scripts/typecheck-server.test.ts — il cancello deve DIRE quando non ha girato.
 *
 * `typecheck-server.ts` lanciava `./client/node_modules/.bin/tsc` con
 * spawnSync e ignorava `res.error`: in un worktree fresco (nessun
 * `bun install` in client/) il binario non c'è, stdout e stderr sono vuoti, le
 * `error TS\d+` contate sono 0 e lo script stampava «server type errors: 0
 * (baseline 0)» uscendo zero. Un verde che non è una misura.
 *
 * Qui il tsc è finto — uno shell script in una dir temporanea — così i quattro
 * esiti (assente / crash muto / errori veri / pulito) si provano tutti senza
 * dipendere da cosa è installato sulla macchina che gira i test.
  * @covers GATE-04
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "typecheck-server.ts");

/** Crea un finto `client/node_modules/.bin/tsc` che stampa `out` ed esce `code`. */
function fakeTsc(dir: string, out: string, code: number): void {
  const bin = join(dir, "client", "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "tsc");
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\nexit ${code}\n`);
  chmodSync(path, 0o755);
}

/** Esegue il cancello con `cwd` = dir temporanea (quindi sul tsc finto, o su nessuno). */
function runGate(cwd: string): { status: number | null; out: string } {
  const res = spawnSync("bun", ["run", SCRIPT], { cwd, encoding: "utf8" });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "typecheck-server-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("typecheck:server", () => {
  test("tsc assente: esce non-zero e dice di fare bun install", () => {
    withTmp((dir) => {
      const { status, out } = runGate(dir);
      expect(status).not.toBe(0);
      expect(out).toContain("bun install");
      expect(out).not.toContain("server type errors: 0 (baseline 0)");
    });
  });

  test("tsc che crolla senza stampare 'error TS': non è uno zero", () => {
    withTmp((dir) => {
      fakeTsc(dir, "error: cannot read tsconfig.server.json", 2);
      const { status, out } = runGate(dir);
      expect(status).not.toBe(0);
      expect(out).toContain("senza stampare");
    });
  });

  test("errori di tipo veri: esce non-zero col conteggio", () => {
    withTmp((dir) => {
      fakeTsc(dir, "server/a.ts(1,1): error TS2322: Type 'x' is not assignable.", 2);
      const { status, out } = runGate(dir);
      expect(status).not.toBe(0);
      expect(out).toContain("0 → 1");
    });
  });

  test("tsc pulito: esce zero", () => {
    withTmp((dir) => {
      fakeTsc(dir, "", 0);
      const { status, out } = runGate(dir);
      expect(status).toBe(0);
      expect(out).toContain("server type errors: 0 (baseline 0)");
    });
  });
});
