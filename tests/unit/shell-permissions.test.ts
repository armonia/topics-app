/**
 * I PERMESSI CHE IL GUSCIO DEVE DICHIARARE.
 *
 * Su macOS un permesso non dichiarato non e' un permesso negato con un
 * messaggio: e' una richiesta che fallisce SUBITO e senza pannello. L'utente
 * preme, non succede niente, e non c'e' niente da leggere da nessuna parte.
 *
 * E' successo davvero, ed e' costato giorni. La dettatura e la nota vocale non
 * hanno mai funzionato nel guscio desktop, e la caccia era partita dal telefono
 * perche' e' li' che si era notato per primo. Misurato il 14/08 sull'app
 * installata (`~/Applications/Topics.app/Contents/Info.plist`): nessuna chiave
 * `Usage`, nemmeno una. `getUserMedia({audio:true})` non poteva riuscire in
 * nessuna versione.
 *
 * Questo test guarda il SORGENTE del plist, che e' l'unico posto in cui la
 * dichiarazione si puo' perdere: `tauri build` lo fonde nel bundle, quindi se
 * la chiave c'e' qui c'e' anche nell'app.
  * @covers STT-04
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLIST = join(import.meta.dir, "..", "..", "desktop-tauri", "src-tauri", "Info.plist");

/**
 * Cosa il guscio CHIEDE al sistema, e quindi cosa deve dichiarare.
 *
 * Una voce si aggiunge qui quando il client inizia a usare quella capacita',
 * non quando qualcuno si accorge che non funziona.
 */
const RICHIESTI = [
  {
    chiave: "NSMicrophoneUsageDescription",
    perche: "la dettatura e la nota vocale chiamano getUserMedia({audio:true})",
  },
];

describe("il guscio dichiara i permessi che chiede", () => {
  const plist = readFileSync(PLIST, "utf8");

  for (const { chiave, perche } of RICHIESTI) {
    test(`${chiave} — ${perche}`, () => {
      expect(plist).toContain(`<key>${chiave}</key>`);
    });

    test(`${chiave} ha una frase VERA, non un segnaposto`, () => {
      // La stringa e' cio' che macOS mostra nel pannello del permesso, ed e' il
      // punto in cui una persona decide se dire di si'. Una frase generica la'
      // dentro e' il motivo per cui un permesso viene negato.
      const m = plist.match(new RegExp(`<key>${chiave}</key>\\s*<string>([^<]*)</string>`));
      expect(m, `${chiave} non ha una <string> accanto`).not.toBeNull();
      const frase = (m?.[1] ?? "").trim();
      expect(frase.length, `la frase di ${chiave} e' troppo corta per spiegare qualcosa`).toBeGreaterThan(40);
      expect(frase.toLowerCase()).not.toContain("todo");
      expect(frase.toLowerCase()).not.toContain("lorem");
    });
  }

  test("il plist resta un plist valido (una chiave orfana lo rompe in silenzio)", () => {
    const chiavi = (plist.match(/<key>/g) ?? []).length;
    const chiusure = (plist.match(/<\/key>/g) ?? []).length;
    expect(chiavi).toBe(chiusure);
    expect(plist).toContain("</plist>");
  });
});
