/**
 * A guard is worth something only once you have seen it RED. Here it is seen:
 * every case writes a fake file, runs the real script over it, and asserts on
 * the exit code, which is the thing that stops CI.
 *
 * The script runs as a process instead of importing its functions, for the same
 * reason `check-emdash.test.ts` does: `main()` runs at import and calls
 * `process.exit`, and what has to be proven is the gate, not the helpers.
 *
 * Passing file paths puts the script in ABSOLUTE mode, so these cases never
 * touch `scripts/ui-language-baseline.json` and cannot be made green by the
 * frozen debt of the real tree.
  * @covers GATE-03
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "check-ui-language.ts");
const dirs: string[] = [];

function fixture(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ui-language-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, body, "utf-8");
  return file;
}

async function run(...files: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...files], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("check-ui-language", () => {
  test("an Italian title= fails, and the report names the line and the attribute", async () => {
    const file = fixture("View.tsx", `export const V = () => <button title="Chiudi la scheda" />;\n`);
    const { code, out } = await run(file);
    expect(code).toBe(1);
    expect(out).toContain("FAIL");
    expect(out).toContain(":1");
    expect(out).toContain("attr:title");
  });

  test("the same title in English passes", async () => {
    const file = fixture("View.tsx", `export const V = () => <button title="Close the tab" />;\n`);
    expect((await run(file)).code).toBe(0);
  });

  test("the per-line escape hatch waives it, because sometimes the Italian IS the data", async () => {
    const file = fixture(
      "View.tsx",
      `export const V = () => <button title="Chiudi la scheda" />; // allow-italian: fixture text compared by value\n`,
    );
    expect((await run(file)).code).toBe(0);
  });

  test("the other three readable attributes are watched too", async () => {
    const aria = fixture("A.tsx", `export const A = () => <i aria-label="Apri le impostazioni" />;\n`);
    const placeholder = fixture("P.tsx", `export const P = () => <input placeholder="Cerca un progetto" />;\n`);
    const alt = fixture("I.tsx", `export const I = () => <img alt="Anteprima della consegna" />;\n`);
    expect((await run(aria)).code).toBe(1);
    expect((await run(placeholder)).code).toBe(1);
    expect((await run(alt)).code).toBe(1);
  });

  test("a JSX text node counts, not just an attribute", async () => {
    const file = fixture("V.tsx", `export const V = () => <p>Nessun risultato per questa ricerca</p>;\n`);
    const { code, out } = await run(file);
    expect(code).toBe(1);
    expect(out).toContain("jsx");
  });

  test("an accent alone is enough: no stopword list covers every word", async () => {
    const file = fixture("V.tsx", `export const V = () => <p>Non c'è più niente qui</p>;\n`);
    expect((await run(file)).code).toBe(1);
  });

  test("a COMMENT is never scanned, in either form", async () => {
    // Comments in this repo are Italian by design and there are thousands of
    // them. A gate that flagged them would be switched off within a week.
    const file = fixture(
      "V.tsx",
      `// il pannello mostra la cartella scelta\n/* nessuna anteprima per questo file */\nexport const V = () => <p>No results</p>;\n`,
    );
    expect((await run(file)).code).toBe(0);
  });

  test("matching is on whole tokens: an English word containing an Italian one is fine", async () => {
    // "alternative" contains "alt", "content" contains "con", "nominal"
    // contains "nomi". A substring rule would flag all three.
    const file = fixture(
      "V.tsx",
      `export const V = () => <p title="Alternative content, nominal state">Pane sale here</p>;\n`,
    );
    expect((await run(file)).code).toBe(0);
  });

  test("the hyphen belongs to the token, so a non-empty server error stays green", async () => {
    // The commonest false positive there is: every validation error in the
    // server writes "non-empty string", and "non" is the commonest Italian word.
    const file = fixture("route.ts", `export const r = () => json({ error: "path (non-empty string) is required" });\n`);
    expect((await run(file)).code).toBe(0);
  });

  test("a server payload the client renders is scanned in a plain .ts", async () => {
    const file = fixture(
      "route.ts",
      `export const r = () => json({ error: "percorso non valido", detail: "la cartella non esiste" });\n`,
    );
    const { code, out } = await run(file);
    expect(code).toBe(1);
    expect(out).toContain("payload:error");
    expect(out).toContain("payload:detail");
  });

  test("a regex holding backticks does not swallow the rest of the file", async () => {
    // The exact false positive `check-emdash.ts` had to fix once: an
    // unmodelled regex opens a phantom template literal and everything after
    // it is read as one string.
    const file = fixture("V.tsx", "export const R = /```[\\s\\S]*?```/g;\n// nessuna anteprima\n");
    expect((await run(file)).code).toBe(0);
  });

  test("a string that is not one of the four attributes or four keys is out of scope", async () => {
    // The gate watches what a person READS. A className, a data attribute or an
    // object key is not that, and widening it is how a guard starts crying wolf.
    const file = fixture("V.tsx", `export const V = () => <p className="riga-selezionata" data-stato="aperto" />;\n`);
    expect((await run(file)).code).toBe(0);
  });

  // ---------------------------------------------------------------------
  // What the first cut could not see, and the report that said OK anyway
  // ---------------------------------------------------------------------

  test("a label written as a JSX expression is still a label", async () => {
    // `{'Consenti'}` and `{n ? 'Invia' : 'Avanti'}` were invisible. allow-italian: the quoted labels ARE the case under test. The JSX
    // pass stripped every brace before looking, so the gate read the markup of
    // a permission panel and reported nothing.
    const file = fixture("V.tsx", `export const V = () => <button>{ok ? 'Consenti' : 'Nega'}</button>;\n`);
    const { code, out } = await run(file);
    expect(code).toBe(1);
    expect(out).toContain("jsx-expr");
  });

  test("the value of a label-ish field is read wherever it is written", async () => {
    const file = fixture("V.tsx", `export const MENU = [{ id: 'back', label: 'Indietro' }];\n`);
    const { code, out } = await run(file);
    expect(code).toBe(1);
    expect(out).toContain("field:label");
  });

  test("a plain .ts module is scanned whole: no JSX is not the same as no copy", async () => {
    // `PERMISSION_LABELS` is a Record keyed by an enum, so no field name in any
    // list would have caught it. In a module without markup, Italian is copy by
    // elimination.
    const file = fixture(
      "labels.ts",
      `export const PERMISSION_LABELS = { allow: 'Consenti sempre', deny: 'Nega' };\n`,
    );
    const { code, out } = await run(file);
    expect(code).toBe(1);
    expect(out).toContain("[module]");
  });

  test("English hard-coded in a file that already imports useT is a hit of its own", async () => {
    const file = fixture(
      "V.tsx",
      "import { useT } from '../hooks/useT';\n" +
        "export const V = () => { const tr = useT(); return <button title={tr('a.b')}>Copy</button>; };\n",
    );
    const { code, out } = await run(file);
    expect(code).toBe(1);
    expect(out).toContain("not keyed");
  });

  test("the same English in a file with no translation function is not a hit", async () => {
    // A surface nobody has migrated yet is written in English on purpose. That
    // is a plan, not a regression, and a gate that called it one would be red
    // on every file in the tree the day it landed.
    const file = fixture("V.tsx", `export const V = () => <button>Copy</button>;\n`);
    expect((await run(file)).code).toBe(0);
  });

  test("the default label of a shared dialog is read even without useT", async () => {
    // ConfirmDialog hard-codes both buttons as destructuring defaults, and the
    // caller that omits them ships "Move to trash" next to "Cancel".
    const file = fixture(
      "D.tsx",
      "export function D({ confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) { return <b>{confirmLabel}{cancelLabel}</b>; }\n",
    );
    const { code, out } = await run(file);
    expect(code).toBe(1);
    expect(out).toContain("field:confirmLabel");
  });

  test("an identifier, a header name and a class list are not copy", async () => {
    // The tight half of the second pass: one false positive here accuses
    // somebody who did the work, which is how a gate stops being read.
    const file = fixture(
      "V.tsx",
      "import { useT } from '../hooks/useT';\n" +
        "export const V = () => { const tr = useT(); return <p title={tr('a.b')} " +
        "className=\"flex items-center gap-2\">{'Content-Type'}{'ArrowDown'}{'https://a.b/c'}</p>; };\n",
    );
    expect((await run(file)).code).toBe(0);
  });
});
