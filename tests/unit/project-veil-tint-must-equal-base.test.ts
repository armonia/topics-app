/**
 * Il velo della `pane-chrome-bar` porta la tinta di `--bg-surface`, non quella
 * del chrome e non il vuoto puro.
 *
 * PERCHE' CONTA. La barra delle tab e' `position: absolute` sopra la
 * conversazione: i messaggi scorrono sotto di lei. Senza velo, il testo che
 * scorre appare direttamente dietro i nomi delle tab. Con un velo a tinta =
 * chrome, il bordo basso della barra mostra un gradino di colore visibile
 * (misurato in tutte e quattro le combinazioni web/mac x chiaro/scuro: da 3 a
 * 14 punti di delta). Con tinta = `--bg-surface` il gradino e' zero per
 * costruzione: stendere un colore su se stesso a qualunque alpha non lo sposta.
 *
 * COSA VERIFICA. Il CSS di produzione (`client/src/index.css`) deve contenere
 * `--chrome-overlay-bg` con un valore che:
 *   1. non e' `transparent` (il velo deve esistere);
 *   2. fa riferimento a `--bg-surface` come tinta (non a `--chrome-bg` o a un
 *      colore opaco scritto a mano).
 *
 * La seconda condizione e' la tesi `project_veil-tint-must-equal-base`: il
 * velo porta la tinta della superficie su cui galleggia, non quella del chrome.
 *
 * COSA NON VERIFICA. Il valore computato a runtime (quello dipende dal tema e
 * dal browser). Qui si controlla solo che la sorgente dichiara l'invariante
 * corretto; `chrome-bar-overlay.spec.ts` verifica il comportamento geometrico.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RADICE = join(import.meta.dir, "..", "..");
const CSS = readFileSync(join(RADICE, "client", "src", "index.css"), "utf8");

/** Estrae il valore di `--chrome-overlay-bg` dalla regola `:root { ... }` */
function valoreChromeOverlay(css: string): string | null {
  const m = css.match(/:root\s*\{[^}]*--chrome-overlay-bg\s*:\s*([^;}]+)/);
  return m ? m[1].trim() : null;
}

describe("project_veil-tint-must-equal-base", () => {
  const valore = valoreChromeOverlay(CSS);

  it("--chrome-overlay-bg e' dichiarato in :root", () => {
    expect(valore).not.toBeNull();
  });

  it("il velo non e' vuoto: --chrome-overlay-bg non e' transparent", () => {
    expect(valore).not.toBe("transparent");
  });

  it("la tinta del velo e' --bg-surface, non il chrome ne' un colore opaco", () => {
    // La forma corretta e' color-mix(in srgb, var(--bg-surface) <alpha>%, transparent)
    // Verificare che --bg-surface sia presente garantisce che la tinta = base.
    expect(valore).toContain("--bg-surface");
  });

  it("il velo e' semitrasparente: usa transparent come secondo termine del mix", () => {
    // color-mix con transparent garantisce che ci sia dell'alpha.
    // Un colore opaco (es. #1b1c1d) coprirebbe tutto e non sarebbe un velo.
    expect(valore).toContain("transparent");
  });
});
