/**
 * @covers RELEASE-02
 */
import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { PKG, readVersions } from "./version-sources";

/**
 * Le QUATTRO dichiarazioni della versione dell'app devono dire lo stesso numero.
 *
 * `scripts/bump-version.sh` esiste apposta: la sua intestazione elenca i quattro
 * file «sources of truth» e il commento alla riga 56 spiega perché il quarto ci
 * sta — «senza questo ogni bump lascia il lock una versione indietro, e il
 * PROSSIMO `cargo build`/`cargo check` locale lo riscrive come rumore non
 * committato (un Cargo.lock sporco è già passato dentro due PR)». Cioè: il
 * problema era già stato visto, capito e risolto NELLO SCRIPT.
 *
 * ERA UNA REGOLA SCRITTA E NON FATTA RISPETTARE. Niente obbliga a passare da
 * quello script, e infatti i bump fatti a mano non ci sono passati: 2.2.93
 * (05663b07), 2.2.94 (879e0bb5) e 2.2.95 (88d72e9a) toccano TRE file ciascuno —
 * package.json, tauri.conf.json, Cargo.toml — e mai `Cargo.lock`. Misurato su
 * 88d72e9a: `Cargo.toml` diceva 2.2.95 e il `Cargo.lock` committato diceva
 * ancora **2.2.90**, cinque versioni indietro, esattamente il difetto che lo
 * script era stato scritto per impedire.
 *
 * COSA COSTA DAVVERO, visto che Cargo.toml vince comunque sul lock: un albero
 * che si sporca da solo. Chiunque lanci `cargo check` in `desktop-tauri/` si
 * ritrova `Cargo.lock` modificato senza aver toccato niente — ed è così che una
 * riga di versione entra per sbaglio in un commit che parla d'altro, o che una
 * sessione la porta via a un'altra. Il rumore non è la versione: è il file che
 * cambia da solo sotto le mani di chi sta facendo altro.
 *
 * Questo test è il cancello che allo script mancava: gira dentro `test:unit`,
 * quindi dentro il job `check` della CI, e diventa rosso appena i quattro numeri
 * si scollano — prima del push, non dopo. Non impone di usare
 * `bump-version.sh`: impone il RISULTATO che quello script produce, che è la
 * cosa di cui il repo ha bisogno.
 *
 * SEGUITO (12/08): il cancello ha fatto il suo lavoro altre due volte nella
 * stessa notte, e altre due volte il numero è stato riallineato a mano. Un
 * cancello che ha ragione ma non dice cosa fare costa un giro ogni volta, quindi
 * ora il gesto ha un nome — `bun run bump <X.Y.Z>` per bumpare, `bun run bump
 * sync` per riallineare un albero già scollato — ed è nominato nel messaggio di
 * errore qui sotto, in CONTRIBUTING e nel kickoff della board.
 */

const ROOT = resolve(import.meta.dir, "..", "..");

describe("la versione dell'app è dichiarata una volta sola, in quattro posti", () => {
  // Estratte prima delle asserzioni: un `null` qui non è «versioni diverse», è
  // «il formato del file è cambiato e questo test non sa più leggerlo» — e i due
  // casi meritano messaggi diversi, altrimenti un giorno si sistema il numero
  // sbagliato per far tacere un test che stava dicendo un'altra cosa.
  //
  // I quattro path e le quattro regex stanno in `./version-sources`: le legge
  // anche `bump-version.test.ts`, che prova il gesto su un albero di prova. Un
  // metro solo per il cancello e per la prova che il gesto lo rimette verde.
  const trovate = readVersions(ROOT);

  test("ognuno dei quattro file dichiara una versione leggibile", () => {
    for (const [file, v] of Object.entries(trovate)) {
      expect(v, `${file}: nessuna versione semver trovata — il formato del file è cambiato`).not.toBeNull();
    }
  });

  test("i quattro numeri coincidono", () => {
    const atteso = trovate[PKG];
    // package.json è la sorgente canonica: è da lì che `bump-version.sh` legge
    // il numero corrente prima di incrementarlo.
    expect(atteso).not.toBeNull();
    for (const [file, v] of Object.entries(trovate)) {
      expect(v, `${file} dice ${v}, ma package.json dice ${atteso}. UN gesto li riallinea tutti e quattro: \`bun run bump sync\` (tiene il numero di package.json) oppure \`bun run bump ${atteso}\`.`).toBe(atteso);
    }
  });
});
