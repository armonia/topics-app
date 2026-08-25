/**
 * Il cancello sul codice morto può essere cieco su un file intero senza dirlo:
 * basta che qualcuno importi quel modulo con un `import()` opaco. `scripts/
 * check-deadcode-blindspots.ts` lo misura piazzando una sonda per file e
 * pretendendo che torni nel report — vedi lì il perché per esteso.
 *
 * Questi test coprono i pezzi puri di quello script (il costo di una run vera è
 * un knip intero, quindi sta in CI, non in `test:unit`) più due reti che non
 * costano niente: nessuna sonda dimenticata in un file tracciato, e nessuna
 * riga di KNOWN_BLIND che punta a un file sparito.
  * @covers GATE-10
 */
import { describe, it, expect } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  PROBE_MARKER,
  stripJsonComments,
  readKnipWorkspaces,
  entriesFromPackageScripts,
  withProbe,
  withoutProbe,
  filesWhereProbeWasSeen,
  KNOWN_BLIND,
} from "../../scripts/check-deadcode-blindspots";

const REPO_ROOT = join(import.meta.dir, "../..");

describe("check-deadcode-blindspots — i pezzi puri", () => {
  it("toglie i commenti jsonc SENZA toccare quelli dentro le stringhe", () => {
    // È il caso che una regex sbaglia: `"https://…"` contiene `//`, e knip.jsonc
    // ce l'ha davvero nella prima riga (`$schema`).
    const src = `{
      // fuori
      "$schema": "https://unpkg.com/knip@6/schema.json", /* anche qui */
      "path": "a/*/b", // in coda
      "esc": "dice \\"//\\" e basta",
    }`;
    const parsed = JSON.parse(stripJsonComments(src)) as Record<string, string>;
    expect(parsed.$schema).toBe("https://unpkg.com/knip@6/schema.json");
    expect(parsed.path).toBe("a/*/b");
    expect(parsed.esc).toBe('dice "//" e basta');
  });

  it("legge i workspace veri di knip.jsonc e spoglia il `!` degli entrypoint", () => {
    const ws = readKnipWorkspaces(readFileSync(join(REPO_ROOT, "knip.jsonc"), "utf8"));
    const root = ws.find((w) => w.dir === "");
    const client = ws.find((w) => w.dir === "client");
    expect(root).toBeDefined();
    expect(client).toBeDefined();
    // `server/ai-bridge-bridge.mjs!` → il `!` è un modificatore di knip, non
    // parte del glob: se restasse, il match non prenderebbe mai.
    expect(root!.entry.some((e) => e.endsWith("!"))).toBe(false);
    expect(root!.entry).toContain("server/ai-bridge.mjs");
    expect(client!.project).toContain("src/**/*.{ts,tsx}");
  });

  it("conta come entrypoint anche i file citati negli `scripts` di package.json", () => {
    // Senza questo pezzo sei script cablati risultavano «ciechi», ed era un
    // falso allarme: knip non riporta gli export dei file di ingresso.
    const entries = entriesFromPackageScripts(
      JSON.stringify({ scripts: { a: "bun run scripts/gen-shortcuts.ts", b: "node ./scripts/x.mjs --flag", c: "tsc -b" } }),
      "",
    );
    expect(entries).toContain("scripts/gen-shortcuts.ts");
    expect(entries).toContain("scripts/x.mjs");
    expect(entries).not.toContain("tsc");
  });

  it("la sonda si mette e si toglie senza lasciare tracce", () => {
    for (const src of ["export const a = 1;\n", "export const a = 1;" /* senza \n finale */]) {
      const probed = withProbe(src);
      expect(probed).toContain(PROBE_MARKER);
      expect(withoutProbe(probed).trimEnd()).toBe(src.trimEnd());
    }
  });

  it("legge dal report JSON di knip i file in cui la sonda è stata VISTA", () => {
    const report = JSON.stringify([
      { file: "client/src/lib/api.ts", exports: [{ name: "__knipBlindspotProbe" }] },
      { file: "server/db.ts", types: [{ name: "Qualcosa" }] },
    ]);
    const seen = filesWhereProbeWasSeen(report);
    expect(seen.has("client/src/lib/api.ts")).toBe(true);
    expect(seen.has("server/db.ts")).toBe(false);
  });

  it("un report illeggibile non diventa «tutti ciechi» per sbaglio… anzi sì, e va bene così", () => {
    // Se knip non produce JSON, `seen` è vuoto e il check grida invece di
    // passare in silenzio: l'errore rumoroso è quello giusto per un cancello.
    expect(filesWhereProbeWasSeen("non è json").size).toBe(0);
  });
});

describe("check-deadcode-blindspots — le reti", () => {
  it("nessuna sonda dimenticata in un file tracciato", () => {
    // Lo script rimette a posto in `finally`, ma una run ammazzata a metà lascia
    // la riga nell'albero. Se qualcuno la committa, questo test lo dice subito.
    // `git grep` legge l'indice: niente scansione a mano dei sorgenti.
    let hits = "";
    try {
      hits = execFileSync("git", ["grep", "-l", "--", PROBE_MARKER], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
    } catch {
      hits = ""; // `git grep` esce 1 quando NON trova niente: è il caso buono.
    }
    const colpevoli = hits
      .split("\n")
      .filter((f) => f && !f.startsWith("scripts/check-deadcode-blindspots.ts") && !f.startsWith("tests/unit/deadcode-blindspots.test.ts"));
    expect(colpevoli.join("\n")).toBe("");
  });

  it("ogni riga di KNOWN_BLIND punta a un file che esiste ancora", () => {
    // Una lista di eccezioni che parla di file cancellati è una lista che nessuno
    // sta più leggendo — e che copre meno di quanto sembri.
    const fantasmi = KNOWN_BLIND.filter((k) => !existsSync(join(REPO_ROOT, k.file))).map((k) => k.file);
    expect(fantasmi.join("\n")).toBe("");
  });

  it("ogni riga di KNOWN_BLIND ha un motivo scritto", () => {
    const muti = KNOWN_BLIND.filter((k) => !k.reason.trim()).map((k) => k.file);
    expect(muti.join("\n")).toBe("");
  });
});
