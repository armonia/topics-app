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
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RADICE = resolve(import.meta.dir, "../..");
const POPOVER = readFileSync(resolve(RADICE, "client/src/components/Sidebar/VersionPopover.tsx"), "utf8");
const BARRA = readFileSync(resolve(RADICE, "client/src/components/Sidebar/SidebarStatusBar.tsx"), "utf8");
const IT = readFileSync(resolve(RADICE, "client/src/lib/i18n.ts"), "utf8");
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
    const ramoAuto = POPOVER.indexOf("if (autoUpdate)");
    const bottoneScarica = POPOVER.indexOf("onClick={onDownload}");
    expect(ramoAuto, "il ramo dell'automatico deve esistere").toBeGreaterThan(0);
    expect(ramoAuto, "…e venire prima del bottone che deve evitare").toBeLessThan(bottoneScarica);
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

describe("il badge «auto» è solo l'icona", () => {
  it("la parola «auto» non è più stampata accanto al glifo", () => {
    const i = BARRA.indexOf('data-testid="auto-update-badge"');
    expect(i, "il badge deve esistere").toBeGreaterThan(0);
    // Il CONTENUTO dello span, non il suo tag di apertura: si parte dal `>` che
    // chiude l'apertura, altrimenti gli attributi (che contengono la parola
    // «auto» di proposito, in aria-label e title) finiscono nel testo misurato.
    const apertura = BARRA.indexOf(">", BARRA.indexOf("title=", i));
    const corpo = BARRA.slice(apertura + 1, BARRA.indexOf("</span>", apertura));
    expect(corpo).toContain("RefreshCw");
    // Il TESTO VISIBILE, non il sorgente: `aria-label` e `title` contengono la
    // parola «auto» di proposito, quindi cercarla nel corpo grezzo darebbe un
    // rosso permanente. Si guarda cosa resta togliendo attributi, tag e
    // commenti — cioè quello che finisce sullo schermo.
    //
    // La prima stesura usava una regex `>\s*auto\s*<` e NON ha morso quando ho
    // rimesso la parola: `auto` era su una riga sua, fra il glifo e la chiusura,
    // quindi fra `>` e `<` c'era anche il tag dell'icona. Un test che non ho
    // visto fallire non è un test.
    const testoVisibile = corpo
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")   // commenti JSX
      .replace(/\/\/[^\n]*/g, "")             // commenti di riga
      .replace(/<[^>]*>/g, "")                // tag (con i loro attributi)
      .replace(/\{[^}]*\}/g, "")               // espressioni JS
      .trim();
    expect(testoVisibile, "la parola «auto» è tornata accanto all'icona").toBe("");
  });

  it("l'icona da sola non è muta: resta un nome per chi non la vede", () => {
    // Togliere la parola la toglie anche a uno screen reader. `aria-label` è la
    // differenza fra «più pulito» e «meno accessibile», e costa una riga.
    const i = BARRA.indexOf('data-testid="auto-update-badge"');
    // Qui invece serve il tag INTERO: sono gli attributi che si stanno
    // verificando.
    const corpo = BARRA.slice(i, BARRA.indexOf("</span>", i));
    expect(corpo).toContain("aria-label");
    expect(corpo).toContain("statusBar.autoUpdate");
    // E il senso pieno resta nel tooltip, dov'è il senso pieno di tutta la barra.
    expect(corpo).toContain("statusBar.autoUpdateTitle");
  });
});
