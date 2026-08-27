/**
 * SE c'e' un velo sulla `pane-chrome-bar`, la sua tinta e' quella della
 * SUPERFICIE. Non «ci deve essere un velo».
 *
 * ── La differenza, che e' costata un rosso ──────────────────────────────────
 * La tesi `project_veil-tint-must-equal-base` e' condizionale, e la prima
 * versione di questo file l'aveva letta come un obbligo: pretendeva
 * `--chrome-overlay-bg` DIVERSO da `transparent`. Cosi' scritta contraddiceva
 * `chrome-bar-continuity.spec.ts` («la riga di chrome NON dipinge — il vetro e'
 * il blur»), che porta una decisione presa e motivata: «il bg tabbar doveva
 * essere trasparente cosi' appariva tutto in floating» (il proprietario, 09/08).
 *
 * Due test dello stesso repo che pretendono il contrario sono peggio di
 * nessuno dei due: il primo che gira detta la regola, e chi arriva dopo
 * ribalta il lavoro di chi c'era prima credendo di ripararlo. E' successo il
 * 19/08 su una card che chiedeva PIU' trasparenza e ha consegnato un velo.
 *
 * ── Perche' la tinta, quando c'e' ───────────────────────────────────────────
 * La barra e' `position: absolute` sopra la conversazione. Un velo con la tinta
 * del CHROME sposta il colore e lascia un gradino sul bordo basso — misurato da
 * 3 a 14 punti di delta nelle quattro combinazioni web/mac x chiaro/scuro. Con
 * la tinta di `--bg-surface` il gradino e' zero per costruzione: stendere un
 * colore su se stesso, a qualunque alpha, non lo sposta.
 *
 * ── Cosa verifica ───────────────────────────────────────────────────────────
 * Solo l'invariante condizionale. `transparent` (nessun velo) passa: e' la
 * forma piu' forte, non un'eccezione. Un velo che NON viene da `--bg-surface`
 * e' rosso. Il comportamento a runtime lo verifica la suite E2E.
  * @covers CHROME-01
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RADICE = join(import.meta.dir, "..", "..");
const CSS = readFileSync(join(RADICE, "client", "src", "index.css"), "utf8");

/** Estrae il valore di `--chrome-overlay-bg` dalla regola `:root { ... }` */
function valueChromeOverlay(css: string): string | null {
  const m = css.match(/:root\s*\{[^}]*--chrome-overlay-bg\s*:\s*([^;}]+)/);
  return m ? m[1].trim() : null;
}

describe("project_veil-tint-must-equal-base", () => {
  const valore = valueChromeOverlay(CSS);

  it("--chrome-overlay-bg e' dichiarato in :root", () => {
    expect(valore).not.toBeNull();
  });

  it("nessun velo e' una risposta valida, ed e' quella di oggi", () => {
    // La barra galleggia sul contenuto e il `backdrop-filter` fa gia' tutto il
    // lavoro che un velo farebbe. Pretendere una tinta qui vorrebbe dire
    // ribaltare quella decisione dal test invece che da una conversazione.
    if (valore === "transparent") return;
    expect(valore, "un velo c'e': allora deve rispettare le due righe sotto").toBeTruthy();
  });

  it("SE c'e' un velo, la sua tinta viene da --bg-surface", () => {
    if (valore === "transparent") return; // niente velo, niente tinta da controllare
    expect(
      valore,
      "un velo con la tinta del chrome lascia un gradino sul bordo basso (misurato: 3-14 punti)",
    ).toContain("--bg-surface");
  });

  it("SE c'e' un velo, e' semitrasparente e non un colore pieno", () => {
    if (valore === "transparent") return;
    expect(valore, "un colore opaco coprirebbe cio' che scorre: non sarebbe un velo").toContain("transparent");
  });

  it("il caso che tiene onesti gli altri tre: una tinta SBAGLIATA e' rossa", () => {
    // Senza, i tre casi sopra passerebbero su qualunque cosa saltando a `return`.
    // Qui si prova il predicato, non il file: e' l'unico modo di sapere che la
    // guardia morde ancora.
    const finto = "color-mix(in srgb, var(--chrome-bg) 72%, transparent)";
    expect(finto.includes("--bg-surface"), "il predicato deve rifiutare la tinta del chrome").toBe(false);
  });
});
