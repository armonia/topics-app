#!/usr/bin/env bun
/**
 * QUANTO STA FERMO L'EVENT LOOP DEL SERVER, misurato da fuori.
 *
 * PERCHE' DA FUORI. Il server e' un processo Bun con `bun:sqlite` SINCRONO:
 * ogni `.all()` e' tempo in cui nessun'altra richiesta viene servita. Da dentro
 * servirebbe strumentare ogni rotta; da fuori basta una domanda che non tocca
 * il disco — `/api/system/dispatch-capacity`, 212 byte — chiesta a raffica: il
 * suo tempo di risposta E' il lag, perche' tutto cio' che vede in piu' di
 * qualche millisecondo e' coda dietro a qualcun altro.
 *
 * Uso:  bun run scripts/event-loop-lag.ts [secondi] [--base https://host:port]
 * Nel frattempo si ricarica la finestra dell'app: il picco lo si legge qui.
 */
const arg = process.argv.slice(2);
const secondi = Number(arg.find((a) => /^\d+$/.test(a)) ?? 20);
const baseIdx = arg.indexOf("--base");
const BASE = baseIdx >= 0 ? arg[baseIdx + 1] : "https://localhost:3333";
const SONDA = "/api/system/dispatch-capacity";
const EVERY_MS = 50;

const campioni: { t: number; ms: number }[] = [];
const t0 = Date.now();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

console.log(`sondo ${BASE}${SONDA} ogni ${EVERY_MS}ms per ${secondi}s — ricarica la finestra ORA`);
while (Date.now() - t0 < secondi * 1000) {
  const s = Bun.nanoseconds();
  try {
    await fetch(BASE + SONDA, { tls: { rejectUnauthorized: false } } as RequestInit);
  } catch { /* server giu': il campione vale comunque come attesa */ }
  const ms = (Bun.nanoseconds() - s) / 1e6;
  campioni.push({ t: Date.now() - t0, ms });
  const resta = EVERY_MS - ms;
  if (resta > 0) await Bun.sleep(resta);
}

const ordinati = [...campioni].map((c) => c.ms).sort((a, b) => a - b);
const p = (q: number) => ordinati[Math.min(ordinati.length - 1, Math.floor(ordinati.length * q))];
const sopra = (soglia: number) => campioni.filter((c) => c.ms > soglia).length;

console.log(`\ncampioni: ${campioni.length}`);
console.log(`mediana ${p(0.5).toFixed(1)}ms · p95 ${p(0.95).toFixed(1)}ms · p99 ${p(0.99).toFixed(1)}ms · MAX ${p(1).toFixed(0)}ms`);
console.log(`sopra 100ms: ${sopra(100)} · sopra 500ms: ${sopra(500)} · sopra 1000ms: ${sopra(1000)}`);
const stallo = campioni.filter((c) => c.ms > 200);
if (stallo.length) {
  console.log(`\nstalli > 200ms (t dal via → durata):`);
  for (const c of stallo) console.log(`  ${String(c.t).padStart(6)}ms  →  ${c.ms.toFixed(0)}ms fermo`);
  const totale = stallo.reduce((s, c) => s + c.ms, 0);
  console.log(`\ntotale event loop fermo (solo gli stalli visti): ${(totale / 1000).toFixed(1)}s su ${secondi}s`);
}

// Un file senza import/export non e' un modulo, e il `await` in cima non
// e' permesso: questo lo rende un modulo senza cambiargli il comportamento.
export {};
