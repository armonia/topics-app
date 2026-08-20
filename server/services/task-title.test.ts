/**
 * Il titolo che la board si ricava da sola.
 *
 * Segnalato: «dovrebbe mettere sempre qualcosa di utile per comprendere», e
 * subito dopo «ma deve fare tutto da solo la kanban no?». Quindi: nessuno lo
 * chiede, né all'utente né all'agente — la card nasce e il titolo arriva.
 *
 * Qui si prova la DECISIONE (quando intervenire) e la GUARDIA sulla risposta
 * (che cosa si accetta come titolo). Il modello è finto: quello che conta è che
 * una risposta storta non peggiori mai la card.
 */
import { describe, expect, test } from "bun:test";
import { titoloMigliore, ripulisci } from "./task-title";
import type { AIProvider } from "../providers";

const finto = (risposta: string): AIProvider =>
  ({ complete: async () => ({ content: risposta }) }) as unknown as AIProvider;
const rotto: AIProvider =
  ({ complete: async () => { throw new Error("niente rete"); } }) as unknown as AIProvider;

const DETTATO = {
  text: "Potremmo fare una roba molto figa per poter assicurarci che il nostro browser…",
  description: "Potremmo fare una roba molto figa per poter assicurarci che il nostro browser ide sia perfetto.\n- Omologare la cronologia delle tab di navigazione con quella normale.\n- Metterlo come menu nella sidebar.",
};

describe("quando la board interviene", () => {
  test("IL CASO 235afe11: titolo tagliato + descrizione → si riscrive", async () => {
    const out = await titoloMigliore(finto("Cronologia tab unificata e menu in sidebar"), DETTATO);
    expect(out).toBe("Cronologia tab unificata e menu in sidebar");
  });

  /**
   * IL CONFINE CHE CONTA: un titolo corto è una SCELTA di chi ha scritto la
   * card, non un ripiego. Riscriverlo sarebbe correggere qualcuno che non
   * aveva sbagliato — e la board non deve mai farlo.
   */
  test("un titolo corto scritto da una persona NON si tocca", async () => {
    const out = await titoloMigliore(finto("Un titolo inventato"), {
      text: "Sidebar: tre righe in fondo",
      description: "dettagli lunghi a piacere ".repeat(20),
    });
    expect(out).toBeNull();
  });

  test("senza descrizione non c'è materiale: si tace", async () => {
    const out = await titoloMigliore(finto("Qualcosa"), { text: DETTATO.text, description: null });
    expect(out).toBeNull();
  });

  test("niente modello, niente rete: la card tiene il suo titolo", async () => {
    expect(await titoloMigliore(rotto, DETTATO)).toBeNull();
  });
});

describe("la guardia sulla risposta del modello", () => {
  test("toglie virgolette, prefissi e punto finale", () => {
    expect(ripulisci('"Cronologia delle tab unificata."')).toBe("Cronologia delle tab unificata");
    expect(ripulisci("Titolo: Menu della sidebar")).toBe("Menu della sidebar");
  });

  test("un modello che SPIEGA invece di rispondere viene scartato", () => {
    // È la modalità di guasto più frequente, e un titolo peggiore di quello che
    // c'era è peggio di nessun titolo.
    expect(ripulisci("Ecco tre proposte. La prima è la migliore.")).toBeNull();
  });

  test("prende la prima riga se ne ha date tre", () => {
    expect(ripulisci("Cronologia tab unificata\n2. Menu sidebar\n3. Altro")).toBe("Cronologia tab unificata");
  });

  test("troppo corto o troppo lungo: si scarta", () => {
    expect(ripulisci("Ok")).toBeNull();
    expect(ripulisci("parola ".repeat(30))).toBeNull();
  });

  test("vuoto e spazi: null, non una stringa vuota che cancellerebbe il titolo", () => {
    expect(ripulisci("")).toBeNull();
    expect(ripulisci("   \n  ")).toBeNull();
  });
});

/**
 * COME SBAGLIA UN MODELLO, e cosa non deve mai finire sulla card.
 *
 * Questi casi non erano coperti dal primo giro, e due passavano: `**Titolo**`
 * arrivava sulla card con gli asterischi (il titolo è testo semplice, nessuno
 * lo interpreta) e `{"title": "…"}` ci arrivava con le graffe — è la forma che
 * un modello ha visto mille volte per compiti simili, e «rispondi solo col
 * titolo» non basta a impedirla.
 *
 * La regola: un titolo peggiore di quello che c'era è peggio di nessun titolo.
 * Dove il contenuto si può recuperare lo si recupera, dove no si scarta.
 */
describe("le forme sbagliate della risposta", () => {
  test("il markdown si toglie invece di finire sulla card", () => {
    expect(ripulisci("**Cronologia tab unificata**")).toBe("Cronologia tab unificata");
    expect(ripulisci("## Cronologia tab unificata")).toBe("Cronologia tab unificata");
    expect(ripulisci("*Cronologia tab unificata*")).toBe("Cronologia tab unificata");
    expect(ripulisci("`Cronologia tab` unificata")).toBe("Cronologia tab unificata");
  });

  test("un JSON: si prende il titolo dentro, o si scarta", () => {
    expect(ripulisci('{"title": "Cronologia tab unificata"}')).toBe("Cronologia tab unificata");
    expect(ripulisci('{"titolo": "Cronologia tab unificata"}')).toBe("Cronologia tab unificata");
    // Senza un titolo dentro non c'è niente da salvare: meglio quello di prima.
    expect(ripulisci('{"foo": 1}')).toBeNull();
    expect(ripulisci('{rotto')).toBeNull();
  });

  test("una lista numerata non è un titolo", () => {
    expect(ripulisci("1. Cronologia tab unificata")).toBeNull();
  });

  test("le virgolette tipografiche e i newline in eccesso si tolgono", () => {
    expect(ripulisci("«Cronologia tab unificata»")).toBe("Cronologia tab unificata");
    expect(ripulisci("\n\n\nCronologia tab unificata\n\n")).toBe("Cronologia tab unificata");
  });

  /** Un'emoji in testa è innocua e resta: non è un errore, è uno stile. */
  test("un'emoji non squalifica il titolo", () => {
    expect(ripulisci("🚀 Cronologia tab unificata")).toBe("🚀 Cronologia tab unificata");
  });
});
