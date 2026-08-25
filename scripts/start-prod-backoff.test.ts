/**
 * Il loop di riavvio di start-prod.sh applica un backoff esponenziale sui
 * boot-failure (processi che muoiono prima di BOOT_THRESHOLD secondi).
 *
 * Il 17/08: 506 boot falliti in 10 minuti e 38 secondi (01:00:48 → 01:11:26),
 * un tentativo al secondo, senza nessun freno. Il backoff evita il crash-loop
 * incontrollato e rende l'errore leggibile nel log.
 *
 * Questo test NON lancia start-prod.sh — quel file gestisce processi reali,
 * launchd e lock: sarebbe fragile e lento. Invece estrae la logica del backoff
 * in una funzione pura e la prova direttamente.
 *
 * Il test complementare che verifica che start-prod.sh CONTENGA il codice del
 * backoff sta alla fine.
  * @covers BACKOFF-01
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const START_PROD = join(REPO_ROOT, "scripts", "start-prod.sh");

// ─── logica del backoff (specchio di start-prod.sh) ──────────────────────────

const BOOT_THRESHOLD = 10; // secondi — deve combaciare con start-prod.sh
const BACKOFF_DELAY  = 2;  // ritardo iniziale
const BACKOFF_MAX    = 30; // tetto

/**
 * Calcola il backoff dopo N boot-failure consecutivi.
 * Specchio diretto della logica in start-prod.sh.
 */
function backoffDopoNFailure(n: number): number {
  let cur = 0;
  for (let i = 0; i < n; i++) {
    if (cur < BACKOFF_DELAY) {
      cur = BACKOFF_DELAY;
    } else {
      cur = cur * 2;
    }
    if (cur > BACKOFF_MAX) cur = BACKOFF_MAX;
  }
  return cur;
}

// ─── test sulla logica del backoff ───────────────────────────────────────────

describe("backoff esponenziale sui boot-failure di start-prod.sh", () => {
  it("primo failure: ritardo minimo (BACKOFF_DELAY)", () => {
    expect(backoffDopoNFailure(1)).toBe(BACKOFF_DELAY);
  });

  it("sequenza: 2s → 4s → 8s → 16s → 30s (tetto)", () => {
    expect(backoffDopoNFailure(1)).toBe(2);
    expect(backoffDopoNFailure(2)).toBe(4);
    expect(backoffDopoNFailure(3)).toBe(8);
    expect(backoffDopoNFailure(4)).toBe(16);
    expect(backoffDopoNFailure(5)).toBe(30);
    // Rimane al tetto per sempre
    expect(backoffDopoNFailure(6)).toBe(30);
    expect(backoffDopoNFailure(10)).toBe(30);
  });

  it("zero failure: nessun backoff (crash di produzione)", () => {
    expect(backoffDopoNFailure(0)).toBe(0);
  });

  it("tetto: nessun valore supera BACKOFF_MAX", () => {
    for (let n = 1; n <= 20; n++) {
      expect(backoffDopoNFailure(n)).toBeLessThanOrEqual(BACKOFF_MAX);
    }
  });
});

// ─── test strutturali su start-prod.sh ───────────────────────────────────────

describe("start-prod.sh contiene il backoff (test strutturale)", () => {
  const src = readFileSync(START_PROD, "utf8");

  it("dichiara BOOT_THRESHOLD", () => {
    expect(src).toContain("BOOT_THRESHOLD");
  });

  it("dichiara BACKOFF_DELAY e BACKOFF_MAX", () => {
    expect(src).toContain("BACKOFF_DELAY");
    expect(src).toContain("BACKOFF_MAX");
  });

  it("stampa 'boot-failure' nel log (leggibile nel log di launchd)", () => {
    expect(src).toContain("boot-failure");
  });

  it("il ritardo cresce moltiplicando (backoff esponenziale, non fisso)", () => {
    // La riga del raddoppio: _backoff_cur=$(( _backoff_cur * 2 ))
    expect(src).toContain("_backoff_cur * 2");
  });

  it("esiste un tetto al backoff", () => {
    // La riga del tetto: [ "$_backoff_cur" -gt "$BACKOFF_MAX" ]
    expect(src).toContain("BACKOFF_MAX");
    expect(src).toContain("-gt");
  });

  it("BOOT_THRESHOLD e BACKOFF_DELAY corrispondono alle costanti del test", () => {
    // Estrai i valori dichiarati in start-prod.sh e confrontali.
    const threshMatch = src.match(/BOOT_THRESHOLD=(\d+)/);
    const delayMatch  = src.match(/BACKOFF_DELAY=(\d+)/);
    const maxMatch    = src.match(/BACKOFF_MAX=(\d+)/);
    expect(threshMatch, "BOOT_THRESHOLD mancante").not.toBeNull();
    expect(delayMatch,  "BACKOFF_DELAY mancante").not.toBeNull();
    expect(maxMatch,    "BACKOFF_MAX mancante").not.toBeNull();
    expect(parseInt(threshMatch![1])).toBe(BOOT_THRESHOLD);
    expect(parseInt(delayMatch![1])).toBe(BACKOFF_DELAY);
    expect(parseInt(maxMatch![1])).toBe(BACKOFF_MAX);
  });
});
