/**
 * Il PATH che diamo ai figli deve restare un PATH VALIDO su ogni sistema.
 *
 * Questi test esistono per un difetto che su macOS non si vede in nessun modo, e
 * su Windows toglieva i comandi di sistema dalle mani dell'utente: `augmentPath`
 * separava le voci con `:` ovunque, ma su Windows `:` e' la punteggiatura della
 * LETTERA DI UNITA'. Fare `split(":")` su un PATH di Windows non e' un mancato
 * split: TAGLIA OGNI VOCE A META' sulla sua lettera di unita', e la rigiunzione
 * produce una stringa unica che il sistema legge come una sola cartella
 * inesistente.
 *
 * Misurato su Windows 11 il 2026-08-26, dentro un terminale di Topics: `ping`,
 * un comando di sistema, rispondeva «Termine 'ping' non riconosciuto». Il PATH
 * del figlio conteneva `C:\WINDOWS\system32` ma non come voce propria - era
 * incollato dentro un pezzo piu' lungo, quindi per il sistema non esisteva.
 *
 * Il test gira su macOS e Linux e misura comunque il comportamento di Windows,
 * perche' il separatore lo sceglie `process.platform`: si simula la piattaforma
 * e si ricarica il modulo. Senza questo, il difetto tornerebbe visibile solo a
 * chi installa su Windows.
 */
import { describe, expect, it } from "bun:test";

/** Ricarica `path-env` con `process.platform` simulato, e lo rimette a posto. */
async function withPlatform<T>(platform: string, fn: (m: typeof import("../../server/utils/path-env")) => T): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    // Query string diversa per bypassare la cache dei moduli: il separatore e la
    // lista sono costanti calcolate all'import, quindi un modulo gia' caricato
    // porterebbe con se' la piattaforma di prima.
    const mod = await import(`../../server/utils/path-env?platform=${platform}-${Math.random()}`);
    return fn(mod);
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

describe("augmentPath rispetta il separatore della piattaforma", () => {
  it("su Windows non spezza le voci sulla lettera di unità", async () => {
    const windowsPath = String.raw`C:\WINDOWS\system32;C:\WINDOWS;C:\Program Files\Git\cmd`;
    const out = await withPlatform("win32", (m) => m.augmentPath(windowsPath));
    const parts = out.split(";");

    // La prova che conta: le cartelle di sistema devono essere voci PROPRIE,
    // non pezzi incollati dentro un'altra. `includes()` sulla stringa intera
    // sarebbe passato anche col difetto — e infatti era passato a mano.
    expect(parts).toContain(String.raw`C:\WINDOWS\system32`);
    expect(parts).toContain(String.raw`C:\WINDOWS`);
    expect(parts).toContain(String.raw`C:\Program Files\Git\cmd`);

    // E non deve restare nessuna voce con dentro un separatore unix: se ce n'è
    // una, qualcosa ha unito con `:` ciò che andava unito con `;`.
    for (const p of parts) expect(p).not.toContain(":\\WINDOWS\\system32;");
    expect(out).not.toContain("/usr/bin");
    expect(out).not.toContain("/opt/homebrew/bin");
  });

  it("su unix resta esattamente com'era", async () => {
    const unixPath = "/usr/bin:/bin";
    const out = await withPlatform("darwin", (m) => m.augmentPath(unixPath));
    const parts = out.split(":");
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/bin");
    expect(parts).toContain("/opt/homebrew/bin");
    expect(out).not.toContain(";");
  });

  it("non duplica una voce già presente, su nessuno dei due", async () => {
    const win = await withPlatform("win32", (m) => m.augmentPath(String.raw`C:\WINDOWS;C:\WINDOWS`));
    const winParts = win.split(";").filter((p) => p === String.raw`C:\WINDOWS`);
    expect(winParts).toHaveLength(1);

    const nix = await withPlatform("darwin", (m) => m.augmentPath("/usr/bin:/usr/bin"));
    const nixParts = nix.split(":").filter((p) => p === "/usr/bin");
    expect(nixParts).toHaveLength(1);
  });

  it("le cartelle extra di Windows sono percorsi Windows, non unix", async () => {
    const extra = await withPlatform("win32", (m) => m.EXTRA_PATHS);
    expect(extra.length).toBeGreaterThan(0);
    for (const p of extra) {
      // Il pezzo sotto la home porta il separatore del sistema OSPITE (la home
      // arriva da `userInfo()`, che non si può simulare): su un Mac quel prefisso
      // è `/Users/...`. Ciò che si misura qui è la parte che SCEGLIAMO noi, cioè
      // la coda: deve essere in stile Windows, e non devono esserci le cartelle
      // di unix, che su Windows non esistono e non esisteranno mai.
      expect(p).toContain("\\");
      expect(p).not.toContain("/opt/");
      expect(p).not.toContain("/usr/");
    }
    // La lista di unix NON deve essere finita qui.
    expect(extra).not.toContain("/usr/bin");
    expect(extra).not.toContain("/opt/homebrew/bin");
  });
});
