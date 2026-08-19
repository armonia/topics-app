#!/usr/bin/env node
/**
 * I FRAME, MISURATI SUL POSTO GIUSTO.
 *
 * PERCHÉ ESISTE. «Topics gira a 57 fps» è un numero che l'app dice di sé
 * (`lib/fpsMonitor`), e quel monitor misura una cosa precisa: quanti
 * `requestAnimationFrame` arrivano. Su un pannello a 60 Hz il massimo è 60, e
 * 57 non è «tre frame persi per colpa dell'app» finché non si sa quanti ne
 * chiedeva. Un contatore di rAF su una pagina FERMA misura sé stesso: il
 * browser non ha niente da comporre, quindi consegna i frame quando gli pare —
 * ed è il comportamento giusto, non un difetto.
 *
 * La domanda che conta è un'altra: **durante un gesto**, quanti frame CADONO?
 * Un frame è caduto quando fra due consegne passa più di un intervallo e mezzo
 * del pannello — cioè quando l'occhio vede uno scatto. Qui si scorre davvero,
 * e si contano quelli.
 *
 * COSA NON MISURA, per onestà: la fluidità delle animazioni CSS che vivono sul
 * compositore, che non passano dal main thread e quindi non compaiono in
 * `requestAnimationFrame`. Per quelle serve un profilo del compositore, che da
 * qui non si prende. Questo attrezzo risponde a «il main thread tiene il passo
 * mentre l'utente scorre», che è dove nascono gli scatti che si sentono.
 *
 * Uso:  node scripts/check-frames.mjs [--base URL] [--max-dropped 5]
 * Esce 1 se cadono più frame del tetto, 2 se non riesce a misurare.
 */
import { webkit } from 'playwright';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'https://localhost:3333');
/** Percentuale di frame caduti oltre la quale lo scatto si vede. */
const MAX_DROPPED_PCT = Number(arg('max-dropped', 5));

const b = await webkit.launch().catch(() => null);
if (!b) { console.error('WebKit di Playwright non disponibile'); process.exit(2); }
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const p = await ctx.newPage();
try {
  await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
} catch {
  console.error(`la finestra non si apre su ${BASE}`);
  await b.close();
  process.exit(2);
}
await p.waitForTimeout(12_000); // il boot ha diritto ai suoi frame

/** Un giro di misura dentro la pagina. Se ne fanno N: vedi `GIRI`. */
async function unGiro(p) {
  return p.evaluate(async () => {
  /** Raccoglie gli intervalli fra frame consegnati, mentre `agita` fa qualcosa. */
  const raccogli = (ms, agita) => new Promise((res) => {
    const gap = [];
    let prev = 0;
    const t0 = performance.now();
    const tick = (now) => {
      if (prev) gap.push(now - prev);
      prev = now;
      agita?.(now - t0);
      if (now - t0 < ms) requestAnimationFrame(tick);
      else res(gap);
    };
    requestAnimationFrame(tick);
  });

  // A RIPOSO: serve solo a stabilire il PASSO del pannello, non a giudicare.
  // Su una pagina ferma il browser può consegnare meno frame di quanti il
  // pannello ne offra, ed è corretto che lo faccia.
  const fermo = await raccogli(1500);
  // Il passo è la MEDIANA, non la media: un singolo intervallo lungo (un
  // garbage collect, il compositore che si sveglia) sposta la media e non la
  // mediana, e qui si vuole il ritmo tipico.
  const ord = [...fermo].sort((a, b) => a - b);
  const passo = ord[Math.floor(ord.length / 2)] || 16.7;

  // SOTTO GESTO: si scorre il contenitore più alto che c'è. È qui che il main
  // thread deve tenere il passo, ed è qui che gli scatti si sentono.
  //
  // LO SCROLLER SI CERCA PRIMA DI MISURARE, e se non c'è non si misura affatto.
  // La prima versione lo cercava e poi girava lo stesso: senza un contenitore
  // da scorrere `agita` non faceva niente, quindi si misurava una pagina FERMA
  // e la si giudicava con la soglia di un gesto. Due esecuzioni consecutive
  // hanno dato 0,6% e 13,2% — non perché l'app fosse cambiata in trenta
  // secondi, ma perché la seconda non stava misurando la stessa cosa. Una
  // misura che cambia risposta senza che cambi l'oggetto non è una prova, e
  // ripararla vale più del numero che produceva.
  //
  // `:scope > *` e non `*`: l'elenco completo del DOM su questa app sono
  // migliaia di nodi e `getComputedStyle` per ciascuno costa quanto il gesto
  // che si vuole misurare. Si guardano gli antenati dei pannelli, che è dove
  // gli scroller veri stanno.
  const candidati = [...document.querySelectorAll('[data-testid*="body"], [class*="overflow"], main, section, div')]
    .filter((e) => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 100);
  const scroller = candidati.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
  if (!scroller) return { scrollerTrovato: false };
  // CHI si sta scorrendo, per esteso: due giri che misurano contenitori diversi
  // producono due numeri che non si possono confrontare, e senza questo nome
  // la differenza sembrerebbe una regressione dell'app.
  const chi = scroller.getAttribute('data-testid')
    || `${scroller.tagName.toLowerCase()}.${String(scroller.className || '').slice(0, 40)}`;
  let dove = 0;
  const corsa = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  const sotto = await raccogli(3000, () => {
    dove = (dove + 24) % corsa;
    scroller.scrollTop = dove;
  });

  // Un frame è CADUTO se fra due consegne è passato più di un intervallo e
  // mezzo: sotto quella soglia è jitter di scheduling, sopra è uno scatto.
  const soglia = passo * 1.5;
  const caduti = sotto.filter((g) => g > soglia).length;
  const ordS = [...sotto].sort((a, b) => a - b);
  return {
    passoMs: Number(passo.toFixed(2)),
    hz: Math.round(1000 / passo),
    frameSottoGesto: sotto.length,
    caduti,
    cadutiPct: Number(((caduti / Math.max(1, sotto.length)) * 100).toFixed(1)),
    peggiorGapMs: Number((ordS[ordS.length - 1] ?? 0).toFixed(1)),
    scrollerTrovato: true,
    scroller: chi,
  };
  });
}

/**
 * QUANTI GIRI, e perché più di uno.
 *
 * Misurato il 2026-08-19 su questa macchina — 8,6 GB di swap occupato e altri
 * agenti al lavoro — cinque giri consecutivi hanno dato 13,9 · 1,7 · 7,1 · 1,7
 * · 2,9 per cento. L'app non è cambiata in quei tre minuti: è cambiato ciò che
 * le stava intorno. Un solo giro avrebbe autorizzato sia «tutto bene» sia
 * «grave regressione», cioè non avrebbe deciso niente.
 *
 * Si tiene la MEDIANA e non la media: qui l'evento raro è un giro schiacciato
 * da qualcun altro sulla stessa CPU, e la media lo lascia entrare mentre la
 * mediana lo tiene fuori. Il minimo e il massimo restano stampati, perché la
 * dispersione è essa stessa un'informazione: se sono lontani, questa macchina
 * non è un posto dove giudicare la fluidità, ed è più onesto saperlo che
 * ricevere un verde o un rosso a caso.
 */
const GIRI = Number(arg('giri', 5));
const giri = [];
for (let i = 0; i < GIRI; i++) {
  const g = await unGiro(p);
  if (!g.scrollerTrovato) {
    console.error('nessun contenitore scrollabile trovato: la misura non descrive un gesto');
    await b.close();
    process.exit(2);
  }
  giri.push(g);
  console.log(`  giro ${i + 1}: ${g.caduti}/${g.frameSottoGesto} caduti (${g.cadutiPct}%), peggior gap ${g.peggiorGapMs} ms`);
}
await b.close();

const pct = giri.map((g) => g.cadutiPct).sort((a, b) => a - b);
const mediana = pct[Math.floor(pct.length / 2)];
console.log(`\nscroller: ${giri[0].scroller}`);
console.log(`passo del pannello: ${giri[0].passoMs} ms (~${giri[0].hz} Hz)`);
console.log(`frame caduti sotto gesto — mediana ${mediana}%  (min ${pct[0]}%, max ${pct[pct.length - 1]}%)`);
if (pct[pct.length - 1] - pct[0] > 8) {
  console.log('  ⚠ dispersione alta: questa macchina è carica, il numero è meno affidabile del solito');
}
if (mediana > MAX_DROPPED_PCT) {
  console.error(`\n✗ ROSSO: mediana ${mediana}% di frame caduti (tetto ${MAX_DROPPED_PCT}%)`);
  process.exit(1);
}
console.log(`\n✓ verde: mediana ${mediana}% ≤ ${MAX_DROPPED_PCT}%`);
