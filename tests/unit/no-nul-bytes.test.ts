/**
 * Un byte NUL in un sorgente non si vede e non si trova: `grep -r` salta
 * l'intero file come binario, e dentro una stringa produce un confronto che
 * fallisce fra due valori stampati identici. Questo test è la rete — vedi
 * scripts/check-nul-bytes.ts per il perché per esteso.
  * @covers GATE-08
 */
import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isTextSource, scanForNulBytes, trackedFiles } from "../../scripts/check-nul-bytes";

const REPO_ROOT = join(import.meta.dir, "../..");

describe("byte NUL nei sorgenti", () => {
  it("nessun file tracciato ne contiene", () => {
    const hits = scanForNulBytes(REPO_ROOT, trackedFiles(REPO_ROOT));
    // Il messaggio serve più dell'assert: dice DOVE e con che contorno.
    const dettaglio = hits.map((h) => `${h.path} (${h.count} NUL @ ${h.offset}) …${h.context}…`).join("\n");
    expect(dettaglio).toBe("");
  });

  it("guarda solo i file di testo — i binari veri sono pieni di NUL per mestiere", () => {
    expect(isTextSource("server/db.ts")).toBe(true);
    expect(isTextSource("scripts/deploy.sh")).toBe(true);
    expect(isTextSource("public/favicon.ico")).toBe(false);
    expect(isTextSource("assets/logo.png")).toBe(false);
  });

  it("trova davvero un NUL, contorno compreso", () => {
    // Senza questo, un bug nello scanner renderebbe il test qui sopra verde per
    // sempre — che è esattamente il modo in cui una rete smette di essere una rete.
    const dir = mkdtempSync(join(tmpdir(), "nul-check-"));
    writeFileSync(join(dir, "finto.ts"), Buffer.from('const k = "a\0b";\n', "utf8"));
    const [hit] = scanForNulBytes(dir, ["finto.ts"]);
    expect(hit).toMatchObject({ path: "finto.ts", count: 1 });
    expect(hit.context).toContain("␀");
    rmSync(dir, { recursive: true, force: true });
  });
});
