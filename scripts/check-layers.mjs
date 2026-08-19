#!/usr/bin/env node
/**
 * I LAYER DEL COMPOSITORE, contati nel tempo.
 *
 * PERCHÉ ESISTE. La finestra dell'utente teneva 1.633 MB dopo quindici ore,
 * contro i **164 MB di una finestra appena aperta** sulla stessa app
 * (`window-cost.mjs`). Dieci volte tanto, e senza una perdita di heap JS: la
 * sonda dichiarativa (`lib/devHeapProbe`) misurava 800 KB e un DOM PIATTO —
 * stesso numero di nodi e di `<svg>` per tutta la misura.
 *
 * La memoria stava altrove. `vmmap` la nomina: **`owned unmapped (graphics)`**,
 * cioè il backing dei layer di CoreAnimation — 3.127 regioni alle 13:41,
 * **5.585 alle 14:49**, +36 al minuto, 1,2 GB finiti in swap. Quei byte non
 * sono nella heap JS e nessuna sonda scritta in JavaScript può vederli: si
 * osservano solo da fuori, o contando i nodi che li generano.
 *
 * COSA CONTA E PERCHÉ IL CONTEGGIO. Ogni elemento promosso a layer si porta un
 * backing IOSurface, e la sua taglia dipende dai pixel che copre: sommare byte
 * che non possiamo leggere sarebbe un'invenzione, mentre il NUMERO di elementi
 * promossi si conta esattamente. A schermo fermo quel numero deve essere
 * PIATTO. Se sale, qualcuno promuove e non smonta — e `perProprietario` dice
 * chi, che è la sola informazione da cui parta un rimedio.
 *
 * COSA PROMUOVE, ed è ciò che si guarda qui: `backdrop-filter` e `filter`
 * (questa app ne fa uso pesante per il vetro), `will-change`, le trasformazioni
 * 3D, `mix-blend-mode`, e le ANIMAZIONI INFINITE, che tengono vivo un layer per
 * tutta la durata — cioè per sempre — anche quando l'elemento non si vede.
 *
 * Uso:  node scripts/check-layers.mjs [--minuti 6] [--max-crescita 20]
 * Esce 1 se i layer crescono oltre il tetto a schermo fermo, 2 se non misura.
 */
import { webkit } from 'playwright';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'https://localhost:3333');
const MINUTI = Number(arg('minuti', 6));
/**
 * Quanti elementi promossi in più si accettano, a schermo fermo, sull'intera
 * misura. Non zero: un tooltip che compare, un'animazione che parte e finisce
 * spostano il conto di poco e sarebbero rumore. Una CRESCITA no.
 */
const MAX_CRESCITA = Number(arg('max-crescita', 20));

const censimento = () => {
  /** Un nome per l'elemento: il testid più vicino, o la sua classe. */
  const chi = (el) => el.closest('[data-testid]')?.getAttribute('data-testid')
    || `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className ?? '').slice(0, 44)}`;
  const per = new Map();
  const segna = (el, motivo) => {
    const k = `${motivo} · ${chi(el)}`;
    per.set(k, (per.get(k) ?? 0) + 1);
  };
  let promossi = 0;
  for (const el of document.getElementsByTagName('*')) {
    const cs = getComputedStyle(el);
    let promosso = false;
    const bd = cs.backdropFilter || cs.webkitBackdropFilter;
    if (bd && bd !== 'none') { segna(el, 'backdrop-filter'); promosso = true; }
    if (cs.filter && cs.filter !== 'none') { segna(el, 'filter'); promosso = true; }
    if (cs.willChange && cs.willChange !== 'auto') { segna(el, 'will-change'); promosso = true; }
    if (/matrix3d|translateZ|translate3d/.test(cs.transform || '')) { segna(el, 'transform-3d'); promosso = true; }
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') { segna(el, 'blend'); promosso = true; }
    // Un'animazione INFINITA tiene vivo il suo layer per sempre: è la categoria
    // che a schermo fermo continua a costare, quindi va contata a parte.
    if (cs.animationIterationCount?.split(',').some((v) => v.trim() === 'infinite')) {
      segna(el, `anim-infinita(${(cs.animationName || '?').split(',')[0].trim()})`);
      promosso = true;
    }
    if (promosso) promossi++;
  }
  return {
    promossi,
    nodi: document.getElementsByTagName('*').length,
    svg: document.querySelectorAll('svg').length,
    perProprietario: Object.fromEntries([...per].sort((a, b) => b[1] - a[1]).slice(0, 14)),
  };
};

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
await p.waitForTimeout(15_000);

const primo = await p.evaluate(censimento);
console.log(`t0:  ${primo.promossi} elementi promossi · ${primo.nodi} nodi · ${primo.svg} svg`);
console.log('  chi promuove (t0):');
for (const [k, n] of Object.entries(primo.perProprietario)) console.log(`    ${String(n).padStart(4)}  ${k}`);

const passi = Math.max(1, Math.round(MINUTI));
let ultimo = primo;
for (let i = 1; i <= passi; i++) {
  await p.waitForTimeout(60_000);
  ultimo = await p.evaluate(censimento);
  console.log(`t+${String(i).padStart(2)}m: ${ultimo.promossi} promossi · ${ultimo.nodi} nodi · ${ultimo.svg} svg`);
}
await b.close();

const crescita = ultimo.promossi - primo.promossi;
const crescitaNodi = ultimo.nodi - primo.nodi;
console.log(`\nin ${MINUTI} min a schermo fermo: promossi ${crescita >= 0 ? '+' : ''}${crescita} · nodi ${crescitaNodi >= 0 ? '+' : ''}${crescitaNodi}`);
if (crescita > MAX_CRESCITA) {
  console.error(`\n✗ ROSSO: +${crescita} elementi promossi a schermo fermo (tetto ${MAX_CRESCITA}).`);
  console.error(
    '  Ogni elemento promosso tiene un backing IOSurface che la heap JS non\n' +
    '  vede: si accumula in `owned unmapped (graphics)` e finisce in swap.\n' +
    '  `perProprietario` qui sopra dice CHI.',
  );
  process.exit(1);
}
console.log(`\n✓ verde: +${crescita} ≤ ${MAX_CRESCITA}`);
