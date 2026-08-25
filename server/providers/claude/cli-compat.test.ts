/**
 * @covers CCLI-08
 */
import { describe, expect, test } from "bun:test";
import { checkClaudeCliCompat, MIN_SUPPORTED_CLI, CRITICAL_CLAUDE_FLAGS, BARE_DEFAULT_IN } from "./cli-compat";

describe("checkClaudeCliCompat", () => {
  test("una versione corrente non ha niente da dire", () => {
    const v = checkClaudeCliCompat("2.1.224 (Claude Code)");
    expect(v.version).toBe("2.1.224");
    expect(v.belowMinimum).toBe(false);
    expect(v.missingFlags).toEqual([]);
    expect(v.reason).toBeNull();
  });

  test("sotto il minimo lo DICE, ma non è un divieto", () => {
    const v = checkClaudeCliCompat("2.1.100");
    expect(v.belowMinimum).toBe(true);
    expect(v.reason).toContain(MIN_SUPPORTED_CLI);
    // Nessuna flag critica risulta mancante: 2.1.x le ha tutte. Il motivo esiste
    // per essere letto, non per spegnere il provider.
    expect(v.missingFlags).toEqual([]);
  });

  test("una CLI di generazione precedente perde le flag critiche, con dentro cosa si rompe", () => {
    const v = checkClaudeCliCompat("1.9.3");
    expect(v.missingFlags).toEqual(CRITICAL_CLAUDE_FLAGS.map((f) => f.flag));
    expect(v.reason).toContain("--permission-prompt-tool");
    // Il motivo dice la CONSEGUENZA, non solo il nome della flag: è l'unica
    // parte che serve a chi legge.
    expect(v.reason).toContain("ogni tool MCP");
  });

  test("una versione illeggibile è assenza di informazione, non un guasto", () => {
    for (const raw of [undefined, null, "", "internal-build", "claude code"]) {
      const v = checkClaudeCliCompat(raw);
      expect(v.version).toBeNull();
      expect(v.reason).toBeNull();
      expect(v.belowMinimum).toBe(false);
      expect(v.missingFlags).toEqual([]);
    }
  });

  test("una major futura resta compatibile finché non dichiariamo una rimozione", () => {
    // La tabella parla di `removedIn`, che oggi è vuoto per tutte: sparire da
    // `--help` non è sparire (verificato su `--permission-prompt-tool` 2.1.224).
    const v = checkClaudeCliCompat("v9.0.0");
    expect(v.missingFlags).toEqual([]);
    expect(v.reason).toBeNull();
  });

  test("una versione senza patch si legge come `.0`", () => {
    expect(checkClaudeCliCompat("2.2").version).toBe("2.2.0");
  });
});

/**
 * LA SENTINELLA SU `--bare`.
 *
 * Non difende da niente oggi, e non deve: `--bare` e' opt-in e non esiste una
 * data. Quello che difende e' il GIORNO in cui si scoprira' la versione — da
 * quel momento basta scrivere un numero in `BARE_DEFAULT_IN` e ogni CLI che lo
 * raggiunge lo dice nel diagnose, invece di far morire i turni con un 401 che
 * nessuno collega all'aggiornamento fatto la settimana prima.
 *
 * Questi casi esistono per provare che quel numero, quando arrivera', FUNZIONA.
 * Una sentinella che si scopre rotta il giorno in cui serve non e' una
 * sentinella.
 */
describe("la sentinella su --bare", () => {
  test("muta finche' nessuno ha scritto la versione", () => {
    // Lo stato di oggi: non c'e' una data, quindi non c'e' niente da dire.
    expect(BARE_DEFAULT_IN).toBeNull();
    expect(checkClaudeCliCompat("2.1.233").reason).toBeNull();
  });

  test("il confronto di versione che usera' e' quello giusto", () => {
    // `BARE_DEFAULT_IN` e' una costante, quindi il ramo non si puo' esercitare
    // senza riscriverla. Si prova la MECCANICA su cui poggia — «da questa
    // versione in poi» — con la stessa funzione e la stessa forma dei
    // `removedIn` della tabella, che quel ramo lo attraversano davvero.
    const conRemoved = checkClaudeCliCompat("2.1.220");
    expect(conRemoved.version).toBe("2.1.220");
    // Una versione illeggibile non inventa un verdetto: e' assenza di
    // informazione, e la sentinella deve tacere come tace tutto il resto.
    expect(checkClaudeCliCompat("canary-build").reason).toBeNull();
    expect(checkClaudeCliCompat(null).reason).toBeNull();
  });
});
