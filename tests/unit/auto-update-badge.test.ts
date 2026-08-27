/**
 * «AUTOMATICO» VUOL DIRE CHE NON DEVI FARE NIENTE.
 *
 * Segnalato: «mi esce una nuova versione disponibile anche se sono in modalità
 * automatica. Inoltre, invece di scrivere "auto", potremmo mettere direttamente
 * soltanto l'icona».
 *
 * Le due metà sono lo stesso difetto visto da due lati. Col flag
 * `topics-dev.json` acceso le finestre si ricaricano da sole a ogni build
 * (`startDevBundleReload`): l'aggiornamento arriva senza gesti. Il pannello
 * però mostrava «nuova versione disponibile» con il bottone «Scarica», cioè
 * chiedeva a mano una cosa che stava già succedendo — e la barra scriveva
 * «auto» accanto a un'icona che diceva già la stessa cosa.
 *
 * Un avviso che chiede un gesto inutile è peggio di nessun avviso: insegna a
 * ignorare gli avvisi.
  * @covers RELEASE-04
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RADICE = resolve(import.meta.dir, "../..");
const POPOVER = readFileSync(resolve(RADICE, "client/src/components/Sidebar/VersionPopover.tsx"), "utf8");
const BARRA = readFileSync(resolve(RADICE, "client/src/components/Sidebar/SidebarStatusBar.tsx"), "utf8");
const IT = readFileSync(resolve(RADICE, "client/src/lib/i18n-it.ts"), "utf8");
const EN = readFileSync(resolve(RADICE, "client/src/lib/i18n-en.ts"), "utf8");

describe("in automatico l'app non chiede di aggiornare a mano", () => {
  it("il pannello conosce lo stato «si aggiorna da solo»", () => {
    // Legge `devReload` dalla STESSA fonte della barra (`useSystemStatus`): due
    // letture diverse dello stesso fatto un giorno divergono, e la barra
    // direbbe «auto» mentre il pannello chiede di scaricare.
    expect(POPOVER).toContain("useSystemStatus");
    expect(POPOVER).toContain("devReload");
  });

  it("con l'auto acceso NON compare il bottone «Scarica»", () => {
    // Il ramo dell'automatico deve stare PRIMA del blocco che disegna il
    // bottone: dopo, sarebbe codice morto e il difetto resterebbe identico.
    const branchAuto = POPOVER.indexOf("if (autoUpdate)");
    const buttonDownload = POPOVER.indexOf("onClick={onDownload}");
    expect(branchAuto, "il ramo dell'automatico deve esistere").toBeGreaterThan(0);
    expect(branchAuto, "…e venire prima del bottone che deve evitare").toBeLessThan(buttonDownload);
  });

  it("dice comunque che sta arrivando: silenzio no, gesto inutile nemmeno", () => {
    // Togliere il bottone senza dire niente lascerebbe l'utente a chiedersi se
    // l'aggiornamento sia bloccato. La frase nomina CHI agisce (le finestre) e
    // QUANDO (quando è pronta).
    for (const cat of [IT, EN]) {
      const riga = cat.split("\n").find((l) => l.trimStart().startsWith("'version.autoArriving':"));
      expect(riga, "manca la frase dell'aggiornamento automatico").toBeTruthy();
    }
    expect(IT).toContain("le finestre si ricaricano");
    expect(EN).toContain("windows reload");
  });
});

describe("la riga di stato non porta piu' il badge ne' la data", () => {
  it("il badge «auto» non c'e' piu' affatto", () => {
    // Prima era stato ridotto alla sola icona, poi tolto: segnalato che un
    // simbolo il cui significato e' «non devi fare niente» e' un simbolo che si
    // guarda una volta e poi mai piu'. La sua conseguenza pratica ora si vede
    // da sola - in automatico l'avviso di nuova versione non compare proprio.
    expect(BARRA).not.toContain('data-testid="auto-update-badge"');
  });

  it("la data dell'ultimo aggiornamento e' scesa nel dropdown", () => {
    // In riga di stato competeva per larghezza con fps, memoria e versione,
    // che si guardano di continuo, per rispondere a una domanda che si fa una
    // volta ogni tanto. Nel pannello della versione ci sta insieme al numero
    // di build, che e' il posto dove quella domanda si va a fare.
    expect(BARRA).not.toContain("buildIsRecent");
    const POPOVER_SRC = readFileSync(
      resolve(RADICE, "client/src/components/Sidebar/VersionPopover.tsx"), "utf8",
    );
    expect(POPOVER_SRC).toContain('data-testid="version-built-at"');
    // E porta il tempo TRASCORSO accanto alla data: una data assoluta dice
    // quando, il tempo trascorso dice se e' vecchia - ed e' la domanda vera.
    expect(POPOVER_SRC).toContain("buildAgo");
    expect(IT).toContain("version.agoMin");
  });
});
