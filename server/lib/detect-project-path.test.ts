/**
 * @covers PROJECT-06
 */
import { describe, expect, test } from "bun:test";
import { detectProjectPath, type FsProbe } from "./detect-project-path";

/**
 * Il filesystem finto: si dichiara cosa esiste e cosa e' una cartella.
 * Tutto cio' che non e' dichiarato non esiste.
 */
function fs(cartelle: string[], file: string[] = []): FsProbe {
  const c = new Set(cartelle);
  const f = new Set(file);
  return {
    esiste: (p) => c.has(p) || f.has(p),
    eCartella: (p) => c.has(p),
  };
}

const HOME = "/Users/tizio";
const u = (content: string) => ({ role: "user", content });
const a = (content: string) => ({ role: "assistant", content });

describe("detectProjectPath", () => {
  test("una cartella vera nominata nel testo viene legata", () => {
    const out = detectProjectPath(
      [u("lavoriamo in /Users/tizio/progetti/mio")],
      fs(["/Users/tizio/progetti/mio"]),
      HOME,
    );
    expect(out).toBe("/Users/tizio/progetti/mio");
  });

  test("`~/` si espande sulla home", () => {
    const out = detectProjectPath(
      [u("il codice sta in ~/progetti/mio")],
      fs(["/Users/tizio/progetti/mio"]),
      HOME,
    );
    expect(out).toBe("/Users/tizio/progetti/mio");
  });

  describe("il difetto che ha insegnato la regola", () => {
    // Il messaggio vero che ha legato una chat a un eseguibile da 16 KB, e
    // fatto comparire nella barra laterale un progetto fantasma di nome
    // «discord» — il basename del FILE.
    const MESSAGGIO = u(
      "guarda i report di giovanni. Nota pratica: il CLI `discord` NON e' nel " +
      "PATH, sta in ~/.claude/jarvis/router/scripts/discord — invocalo col path pieno.",
    );
    const ESEGUIBILE = "/Users/tizio/.claude/jarvis/router/scripts/discord";

    test("un path che esiste ed e un FILE non viene mai legato", () => {
      const out = detectProjectPath(
        [MESSAGGIO],
        fs(["/Users/tizio/.claude/jarvis/router/scripts"], [ESEGUIBILE]),
        HOME,
      );
      expect(out).toBeNull();
    });

    test("il ripiego non puo CONTRADDIRE il primo giro", () => {
      // E' la regola in una riga. Il primo giro guarda tutti i path del testo e
      // restituisce solo le cartelle: se un path esiste e non e' stato
      // restituito, e' perche' cartella non e'. Il ripiego lo ripescava.
      const out = detectProjectPath(
        [u("il file sta in /Users/tizio/roba/script.sh")],
        fs(["/Users/tizio/roba"], ["/Users/tizio/roba/script.sh"]),
        HOME,
      );
      expect(out).toBeNull();
    });
  });

  describe("il ripiego, che serve e resta", () => {
    test("una cartella che NON esiste ancora si lega: sta per nascere", () => {
      // E' il caso per cui il ripiego e' stato scritto: «creami un progetto in
      // ~/progetti/nuovo» va legato prima che la cartella ci sia.
      const out = detectProjectPath(
        [u("creami un progetto in ~/progetti/nuovo")],
        fs(["/Users/tizio/progetti"]),
        HOME,
      );
      expect(out).toBe("/Users/tizio/progetti/nuovo");
    });

    test("ma il posto che la conterra deve esistere", () => {
      // Senza, un path inventato a meta' frase diventa un progetto che non
      // nascera' mai.
      const out = detectProjectPath(
        [u("creami un progetto in /Users/tizio/inventata/dentro/ancora")],
        fs(["/Users/tizio"]),
        HOME,
      );
      expect(out).toBeNull();
    });

    test("il ripiego guarda SOLO i messaggi dell'utente", () => {
      // Un path proposto dal modello e mai confermato non deve legare niente.
      const out = detectProjectPath(
        [u("fammi un progetto"), a("lo metto in /Users/tizio/progetti/deciso-da-me")],
        fs(["/Users/tizio/progetti"]),
        HOME,
      );
      expect(out).toBeNull();
    });

    test("il PRIMO giro invece legge anche l'assistente, se la cartella esiste", () => {
      // Una cartella che esiste davvero e' un fatto, non una proposta.
      const out = detectProjectPath(
        [u("continuiamo"), a("sto lavorando in /Users/tizio/progetti/vero")],
        fs(["/Users/tizio/progetti/vero"]),
        HOME,
      );
      expect(out).toBe("/Users/tizio/progetti/vero");
    });
  });

  describe("cosa NON e un progetto", () => {
    test("un solo livello non basta: e una radice, non un progetto", () => {
      expect(detectProjectPath([u("vai in /tmp")], fs(["/tmp"]), HOME)).toBeNull();
    });

    test("un testo senza percorsi non lega niente", () => {
      expect(detectProjectPath([u("come stai?")], fs([]), HOME)).toBeNull();
    });

    test("nessun messaggio, nessun legame", () => {
      expect(detectProjectPath([], fs([]), HOME)).toBeNull();
    });

    test("la punteggiatura in coda non entra nel path", () => {
      const out = detectProjectPath(
        [u("lavoriamo in /Users/tizio/progetti/mio.")],
        fs(["/Users/tizio/progetti/mio"]),
        HOME,
      );
      expect(out).toBe("/Users/tizio/progetti/mio");
    });
  });

  test("fra due candidati vince la cartella VERA, non il primo nominato", () => {
    const out = detectProjectPath(
      [u("il file sta in /Users/tizio/roba/x.sh ma il progetto e' in /Users/tizio/progetti/vero")],
      fs(["/Users/tizio/progetti/vero", "/Users/tizio/roba"], ["/Users/tizio/roba/x.sh"]),
      HOME,
    );
    expect(out).toBe("/Users/tizio/progetti/vero");
  });
});
