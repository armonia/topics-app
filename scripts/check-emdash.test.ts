/**
 * La guardia serve a qualcosa solo se la si è vista ROSSA. Qui la si vede: il
 * test scrive un file finto, ci lancia sopra lo script vero e pretende exit 1
 * con la riga giusta nell'output.
 *
 * Lo script si lancia come processo invece di importarne le funzioni di
 * proposito: `main()` gira all'import e chiama `process.exit`, e comunque ciò
 * che va provato è il cancello, cioè il codice di uscita che ferma la CI.
  * @covers GATE-01
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(import.meta.dir, 'check-emdash.ts');
const DASH = '—';
const dirs: string[] = [];

function fixture(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'emdash-'));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, body, 'utf-8');
  return file;
}

async function run(...files: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT, ...files], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out: stdout + stderr };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('check-emdash', () => {
  test('esce 1 e nomina la riga quando il trattino torna in una stringa', async () => {
    const file = fixture('copy.ts', `export const T = "Fatto${DASH}riprova";\n`);
    const { code, out } = await run(file);
    expect(code).toBe(1);
    expect(out).toContain(':1');
    expect(out).toContain('FAIL');
  });

  test('lo vede anche nel testo JSX, non solo fra virgolette', async () => {
    const file = fixture('view.tsx', `export const V = () => <p>Pronto${DASH}ricarica</p>;\n`);
    expect((await run(file)).code).toBe(1);
  });

  test('un commento non è un testo della app: resta verde', async () => {
    const file = fixture('commented.ts', `// nota${DASH}fuori scope\n/* anche qui${DASH}nulla */\nexport const N = 1;\n`);
    expect((await run(file)).code).toBe(0);
  });

  test('un log del server non è un testo della app, nemmeno spezzato su più righe', async () => {
    const file = fixture('logs.ts', `console.warn(\n  "boot fallito${DASH}riprova",\n);\n`);
    expect((await run(file)).code).toBe(0);
  });

  test('una regex con backtick non trascina i commenti che la seguono', async () => {
    // Il falso positivo vero: /```…```/ apriva un template literal fantasma e
    // i commenti sotto finivano segnalati come copy.
    const file = fixture('regex.ts', 'export const R = /```[\\s\\S]*?```/g;\n// nota' + DASH + 'un commento\n');
    expect((await run(file)).code).toBe(0);
  });

  test("l'uscita di sicurezza vale per la riga e per il blocco", async () => {
    const line = fixture('line.ts', `export const A = "x${DASH}y"; // allow-emdash: è il dato\n`);
    expect((await run(line)).code).toBe(0);

    const block = fixture(
      'block.ts',
      `// allow-emdash-block: prompt\nexport const P = "a${DASH}b";\n// end-allow-emdash\n`,
    );
    expect((await run(block)).code).toBe(0);
  });

  test('e resta verde su tutte le sorgenti dei testi della app', async () => {
    expect((await run()).code).toBe(0);
  });
});
