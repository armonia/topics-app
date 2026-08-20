/**
 * IL TITOLO DELLA CARD, quando quello che c'è è un dettato.
 *
 * ── Che cosa si vedeva a schermo (20/08) ───────────────────────────────────
 * Il composer prende la prima riga e la taglia a 77 caratteri. Su un testo
 * scritto è quasi sempre giusto — chi scrive una card mette il titolo in cima —
 * ma su un DETTATO no: si comincia a parlare e il titolo diventa il preambolo.
 *
 *     «Potremmo fare una roba molto figa per poter assicurarci che il nostro
 *      browser…»
 *
 * Settantotto caratteri che non dicono di che cosa parla la card. La sostanza
 * stava tre righe sotto, nei punti elenco: la cronologia delle tab, il menu
 * nella sidebar. Segnalato così: «dovrebbe mettere sempre qualcosa di utile per
 * comprendere».
 *
 * ── Perché un modello e non una regola ─────────────────────────────────────
 * Una regola può tagliare meglio (su parola, su frase: `shared/task-title.ts`),
 * e infatti lo fa — ma non può capire che «assicurarci che il browser sia
 * perfetto» è il preambolo e «omologare la cronologia delle tab» è il punto.
 * Quella è comprensione, e chiederla a un'euristica significa ottenere un
 * titolo diverso ma altrettanto muto.
 *
 * È la stessa scelta già fatta per le chat (`routes/autoname.ts`), con lo
 * stesso provider e la stessa forma di prompt: qui si riusa quel modo di fare
 * invece di inventarne un secondo.
 *
 * ── Le regole che questo rispetta ──────────────────────────────────────────
 *  · NON tocca un titolo che una persona ha scritto BREVE. Se la prima riga sta
 *    nel limite, quello È il titolo scelto: riscriverlo sarebbe correggere
 *    qualcuno che non aveva sbagliato.
 *  · NON tocca un titolo già cambiato a mano fra la chiamata e la risposta: si
 *    rilegge la riga prima di scrivere, come fa l'autoname delle chat.
 *  · Il testo intero resta nella descrizione: qui non si perde niente, si
 *    aggiunge solo un nome leggibile sopra.
 *  · Fallisce in SILENZIO. Nessun modello, nessuna rete, una risposta storta:
 *    resta il taglio su parola, che è già meglio di prima. Un titolo è una
 *    comodità, non un dato: non può far fallire la creazione di una card.
 */

import type { AIProvider } from "../providers";

/** Sotto questa lunghezza la prima riga È il titolo, e non si tocca. */
export const TITOLO_GIA_BUONO = 60;

/**
 * Un titolo migliore per questa card, o `null` se non c'è niente da migliorare
 * (o se non si può).
 *
 * `null` significa «lascia quello che c'è»: chi chiama non deve distinguere
 * fra un errore e una scelta.
 */
export async function titoloMigliore(
  provider: AIProvider,
  args: { text: string; description?: string | null },
): Promise<string | null> {
  const titolo = args.text?.trim() ?? "";
  const descrizione = args.description?.trim() ?? "";
  if (!titolo) return null;

  // UNA PERSONA HA GIÀ SCRITTO UN TITOLO CORTO: è una sua scelta, non un
  // ripiego. Il caso da riparare è l'altro — la prima riga di un dettato, che
  // il composer ha dovuto tagliare (e si riconosce dall'ellissi) o che è
  // comunque troppo lunga per essere un nome.
  const tagliato = titolo.endsWith("…");
  if (!tagliato && titolo.length <= TITOLO_GIA_BUONO) return null;

  // Senza descrizione non c'è materiale in più: il modello riscriverebbe la
  // stessa frase con altre parole, che è rumore.
  if (!descrizione || descrizione.length < titolo.length) return null;

  const materiale = descrizione.slice(0, 1500);
  try {
    const out = await provider.complete([
      {
        role: "user",
        content:
          "Da questa richiesta ricava un TITOLO breve per una card di lavoro: 3-7 parole, " +
          "nella lingua della richiesta, che dica DI CHE COSA si tratta — non come comincia. " +
          "Salta i preamboli («potremmo fare», «vorrei che», «sarebbe bello»): nomina la cosa. " +
          "Niente virgolette, niente punto finale, niente prefissi tipo «Titolo:». " +
          "Rispondi SOLO col titolo.\n\nRichiesta:\n" + materiale,
      },
    ]);
    return ripulisci(out.content ?? "");
  } catch {
    return null; // nessun modello, nessuna rete: resta il taglio su parola
  }
}

/**
 * La risposta del modello, ridotta a titolo — o `null` se non è utilizzabile.
 *
 * Un modello che spiega invece di rispondere è la modalità di guasto più
 * frequente («Ecco un titolo possibile: …», o tre proposte numerate), e un
 * titolo peggiore di quello che c'era è peggio di nessun titolo.
 */
export function ripulisci(raw: string): string | null {
  let s = (raw ?? "").trim();
  if (!s) return null;
  // Una riga sola: se ne ha date tre, si prende la prima non vuota.
  s = s.split("\n").map((r) => r.trim()).filter(Boolean)[0] ?? "";
  s = s.replace(/^(?:titolo|title)\s*[:—-]\s*/i, "");
  s = s.replace(/^["'«»`]+|["'«»`.]+$/g, "").trim();
  if (!s) return null;
  // Troppo lungo = non ha capito la consegna; troppo corto = non dice niente.
  if (s.length < 8 || s.length > 90) return null;
  // Una frase intera con un verbo coniugato e la punteggiatura è una risposta,
  // non un titolo: la riconosciamo dal punto interno.
  if (/[.!?]\s+\S/.test(s)) return null;
  return s;
}
