/**
 * Le soglie del verdetto sono decisioni di PRODOTTO: dicono a una persona che
 * cosa sta guardando. Questo file esiste perché una decisione del genere, finché
 * viveva dentro la JSX, non poteva essere contraddetta da niente.
 *
 * Il caso che ha prodotto il modulo sta per primo, con i suoi numeri veri.
 */
import { describe, it, expect } from 'bun:test';
import { scegliVerdetto, MIN_COMPRESSI_MB, SOGLIA_PRESSIONE_MB } from './verdict';

/** Nessuna causa attiva: il caso buono. */
const quieto = { accelerated: true, compressedMB: 0, totalMB: 400, residentMB: 400, totalCpu: 5 };

describe('quale riga compare sotto i numeri', () => {
  it('IL CASO VERO: 1.788 MB di footprint con 517 residenti lo dice, e prima taceva', () => {
    // Misurato il 2026-08-19 sulla finestra dell'utente che aveva segnalato
    // «1,8 GB». La sola riga sullo swap si accendeva sopra i 2 GB: 1.271 MB
    // compressi non la raggiungevano, quindi non compariva NIENTE e il numero
    // grande restava senza spiegazione.
    const v = scegliVerdetto({
      accelerated: true, compressedMB: 1788 - 517, totalMB: 1788, residentMB: 517, totalCpu: 20,
    });
    expect(v).toEqual({ tipo: 'mostlySwapped', pct: 71, mb: 517 });
  });

  it('la pressione VERA resta prioritaria e continua a consigliare di chiudere', () => {
    // Sopra i 2 GB compressi il consiglio «chiudi qualche pannello» ha senso, e
    // non deve essere scavalcato dalla riga informativa: le due frasi dicono
    // cose opposte, e questa e' quella su cui si puo' agire.
    const v = scegliVerdetto({
      accelerated: true, compressedMB: SOGLIA_PRESSIONE_MB + 1, totalMB: 6000, residentMB: 3000, totalCpu: 10,
    });
    expect(v?.tipo).toBe('compressed');
  });

  it("l'accelerazione spenta viene prima di tutto: e' la causa piu' grave e piu' certa", () => {
    const v = scegliVerdetto({
      accelerated: false, compressedMB: 1271, totalMB: 1788, residentMB: 517, totalCpu: 90,
    });
    expect(v).toEqual({ tipo: 'noAccel' });
  });

  it('e una quota alta su una finestra PICCOLA tace: sarebbero decine di MB, cioe rumore', () => {
    // Stessa proporzione del caso vero (71%), un ordine di grandezza piu' in
    // basso. Se questa riga comparisse qui, comparirebbe quasi sempre — e una
    // riga che c'e' sempre non informa piu' di una che non c'e' mai.
    const v = scegliVerdetto({
      accelerated: true, compressedMB: MIN_COMPRESSI_MB - 1, totalMB: 420, residentMB: 121, totalCpu: 5,
    });
    expect(v).toBeNull();
  });

  it('meta esatta non basta: si parla quando il grosso e davvero di la', () => {
    // Il confine e' stretto (`>`, non `>=`): a meta' e meta' la frase «il grosso
    // e' gia' tornato al sistema» non sarebbe vera.
    const v = scegliVerdetto({
      accelerated: true, compressedMB: 500, totalMB: 1000, residentMB: 500, totalCpu: 5,
    });
    expect(v).toBeNull();
  });

  it('una misura PARZIALE non produce nessuna riga, invece di inventarne una', () => {
    // `compressedMB: null` e' cio' che il componente passa quando la misura non
    // copre tutti i processi. Una percentuale calcolata su una misura parziale
    // sarebbe una piccola bugia detta con precisione.
    const v = scegliVerdetto({
      accelerated: true, compressedMB: null, totalMB: null, residentMB: null, totalCpu: 10,
    });
    expect(v).toBeNull();
  });

  it('il carico CPU parla solo quando la memoria non ha niente da dire', () => {
    const v = scegliVerdetto({ ...quieto, totalCpu: 51 });
    expect(v).toEqual({ tipo: 'loaded' });
  });

  it('nel caso buono NON dice niente: lo dicono gli fps sopra', () => {
    expect(scegliVerdetto(quieto)).toBeNull();
  });

  it("l'accelerazione ancora ignota non viene scambiata per spenta", () => {
    // `null` = non ancora saputo. Trattarlo come `false` metterebbe un allarme
    // rosso su ogni avvio, per il tempo che serve alla prima misura.
    expect(scegliVerdetto({ ...quieto, accelerated: null })).toBeNull();
  });
});
