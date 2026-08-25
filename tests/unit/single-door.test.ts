/**
 * `grants` si interroga da UN posto solo.
 *
 * Questo è un test testuale, e la ragione per cui vale la pena averlo è che il
 * guasto che presidia è silenzioso *nella direzione sicura*. Le otto stringhe
 * SQL che `server/lib/grants-query.ts` ha sostituito avevano tutte
 * `subject_type='device'` scritto a mano. Il giorno in cui il soggetto diventa
 * una persona o un'organizzazione, una query rimasta indietro non sbaglia
 * rumorosamente: legge di MENO. Nessuno vede un errore — si vede una cosa
 * condivisa che non compare, e la si va a cercare nel posto sbagliato.
 *
 * Un `grep` in un test è brutto e regge dove un tipo non arriva: TypeScript non
 * può impedire di scrivere SQL in una stringa.
 *
 * @covers GUEST-06
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const RADICE = join(import.meta.dir, "..", "..");

/** L'unica porta, più il file che dichiara i tipi del modello. */
const AMMESSI = new Set([
  "server/lib/grants-query.ts",
  // Le migration SONO lo schema: è il posto in cui `subject_type` deve comparire.
  "server/db/migrations",
]);

function esplora(dir: string, acc: string[] = []): string[] {
  for (const voce of readdirSync(dir)) {
    if (voce === "node_modules" || voce === ".git" || voce.startsWith(".")) continue;
    const pieno = join(dir, voce);
    if (statSync(pieno).isDirectory()) esplora(pieno, acc);
    else if (/\.(ts|tsx)$/.test(voce)) acc.push(pieno);
  }
  return acc;
}

describe("una porta sola su grants", () => {
  it("nessun altro file scrive SQL su `grants`", () => {
    const sorgenti = [
      ...esplora(join(RADICE, "server")),
      join(RADICE, "server.ts"),
    ];

    const colpevoli: string[] = [];
    for (const f of sorgenti) {
      const rel = f.slice(RADICE.length + 1);
      if (rel.endsWith(".test.ts")) continue;
      if ([...AMMESSI].some((a) => rel === a || rel.startsWith(a + "/"))) continue;

      const testo = readFileSync(f, "utf8");
      // `FROM grants` / `INTO grants` — cioè SQL vero, non la parola in un
      // commento. `subject_type` non compare mai fuori da SQL.
      if (/\b(FROM|INTO|UPDATE)\s+grants\b/i.test(testo) || /subject_type/.test(testo)) {
        colpevoli.push(rel);
      }
    }

    expect(colpevoli).toEqual([]);
    // Non vacuo: se il giro dei file si rompesse (un percorso sbagliato, una
    // ricorsione che non entra), l'elenco sarebbe vuoto e il test verde per il
    // motivo sbagliato. Un test che non può fallire non protegge niente.
    expect(sorgenti.length).toBeGreaterThan(50);
  });

  it("la porta unica contiene davvero l'SQL — cioè il setaccio funziona", () => {
    // La prova che il criterio del test sopra riconosce ciò che cerca. Senza,
    // una regex sbagliata renderebbe il guardiano cieco e silenzioso.
    const porta = readFileSync(join(RADICE, "server/lib/grants-query.ts"), "utf8");
    expect(/\bFROM\s+grants\b/i.test(porta)).toBe(true);
    expect(/subject_type/.test(porta)).toBe(true);
  });
});
