#!/usr/bin/env bun
/**
 * IL BANCO DEL FRENO DEL DISPATCH: carico ALTRUI contro carico NOSTRO.
 *
 * Il tetto automatico (`server/services/dispatch-capacity.ts`) si dimensionava
 * sul load average della macchina INTERA. Il 12/08/2026 su questo host quello
 * valeva 13 su 12 core per colpa delle app di chi stava al computer, mentre i
 * nostri agenti tenevano 0,75 core: il tetto è sceso a 1 con cinque card in
 * coda. Adesso il termine vivo legge la CPU della NOSTRA flotta.
 *
 * Un cambio del genere non si prova a parole, perché le due misure divergono
 * solo SOTTO CARICO. Quindi il banco il carico se lo fabbrica, due volte, e
 * guarda cosa risponde il tetto:
 *
 *  1. CARICO ALTRUI — un `yes` per core, fuori dal nostro albero di processi
 *     (l'ultima shell esce, quindi i burner vengono adottati da launchd).
 *     La macchina è satura ma non per colpa nostra: devono partire almeno 3
 *     agenti. Col vecchio conto ne partiva 1.
 *  2. CARICO NOSTRO — due «agenti» finti, figli del banco, ognuno con tre
 *     bruciatori: sono dentro l'albero della flotta, quindi la sonda li vede
 *     come nostri. Il freno deve mordere ancora, cioè scendere sotto il tetto
 *     strutturale della macchina.
 *
 * Esce NON-ZERO se una delle due gambe cade. È la barra della card, e vale
 * quanto un test: un banco che stampa e basta non ferma niente.
 *
 * Run: `bun run scripts/dispatch-brake-bench.ts [--warmup=60] [--json=<path>]`
 *
 * ATTENZIONE: occupa la macchina per un paio di minuti, apposta. Non lanciarlo
 * mentre gira qualcosa che ti serve veloce.
 */
import os from "node:os";
import { writeFileSync } from "node:fs";
import { getFleetUsage } from "../server/lib/fleet-usage";
import { computeDispatchCapacity, structuralDispatchCapacity } from "../server/services/dispatch-capacity";

const CORES = Math.max(1, os.cpus().length);

/** Quanti secondi si tiene la macchina sotto carico prima di misurare.
 *
 *  Il default è alto per una ragione sola: `load1` è una media esponenziale su
 *  un minuto, quindi dopo dieci secondi di saturazione vale ancora poco più di
 *  niente. Il banco misura anche cosa avrebbe risposto il VECCHIO conto, e per
 *  farlo onestamente il load average deve avere avuto il tempo di salire. */
const WARMUP_DEFAULT_S = 60;

/** La finestra su cui la sonda calcola la CPU istantanea (due letture di `ps`). */
const CAMPIONE_MS = 3000;

/** Dopo quanto i bruciatori si spengono da soli, anche se il banco muore male. */
const AUTO_SPEGNIMENTO_S = 240;

const arg = (nome: string): string | null => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${nome}=`));
  return hit ? hit.slice(nome.length + 3) : null;
};
const attesa = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (script: string) => Bun.spawnSync(["/bin/sh", "-c", script], { stdout: "pipe", stderr: "ignore" });

interface Misura {
  gamba: string;
  /** Quanti agenti il tetto ammette adesso. */
  tetto: number;
  /** Quanti ne ammetteva il VECCHIO conto (`cores - load1`, dimezzato). */
  tettoVecchio: number;
  /** Core-unità che la sonda attribuisce alla NOSTRA flotta. */
  nostriCore: number | null;
  load1: number;
  running: number;
  reason: string;
}

/** Il conto storico, riprodotto qui per il confronto: è quello che si sostituisce. */
function tettoVecchio(load1: number): number {
  const libero = Math.max(0, Math.min(CORES, CORES - load1));
  return Math.min(structuralDispatchCapacity(), Math.max(1, Math.ceil(libero / 2)));
}

/**
 * Due letture di `ps` a distanza nota, perché la CPU della flotta è una
 * DIFFERENZA di secondi di CPU e non una fotografia. Una lettura sola darebbe
 * la media di vita dei processi, che è il difetto che quella sonda ha già avuto.
 */
async function misura(gamba: string, running: number): Promise<Misura> {
  await getFleetUsage();
  await attesa(CAMPIONE_MS);
  await getFleetUsage();
  const cap = computeDispatchCapacity(running);
  return {
    gamba,
    tetto: cap.recommended,
    tettoVecchio: tettoVecchio(cap.load1),
    nostriCore: cap.oursCores,
    load1: cap.load1,
    running,
    reason: cap.reason,
  };
}

/**
 * CARICO ALTRUI: un `yes` per core, adottato da launchd.
 *
 * Il doppio passaggio di shell non è folklore: la sonda della flotta somma
 * l'albero dei processi che discende da NOI, quindi un burner lanciato come
 * figlio verrebbe contato come nostro e il banco misurerebbe la gamba sbagliata.
 * L'ultima shell esce subito, il `yes` resta orfano e passa a pid 1.
 */
function caricoAltrui(): { pids: number[]; spegni: () => void } {
  const pids: number[] = [];
  for (let i = 0; i < CORES; i++) {
    const r = sh("yes > /dev/null & echo $!");
    const pid = Number.parseInt(new TextDecoder().decode(r.stdout).trim(), 10);
    if (Number.isFinite(pid)) pids.push(pid);
  }
  // La rete di sicurezza: se il banco muore di brutto (SIGKILL, terminale
  // chiuso) questi burner resterebbero a girare per sempre su una macchina che
  // nessuno sta guardando. Un guardiano staccato li spegne comunque.
  if (pids.length) sh(`( sleep ${AUTO_SPEGNIMENTO_S}; kill ${pids.join(" ")} 2>/dev/null ) & echo ok`);
  return {
    pids,
    spegni: () => { if (pids.length) sh(`kill ${pids.join(" ")} 2>/dev/null; exit 0`); },
  };
}

/**
 * CARICO NOSTRO: N «agenti» figli del banco, ognuno con `perAgente` bruciatori.
 *
 * Perché più di un bruciatore per agente: uno slot nuovo costa una core-unità,
 * quindi un agente che ne consuma una NON deve stringere il tetto (è
 * l'invariante che toglie l'autoavveramento). Il freno morde quando un agente
 * costa più del suo posto, che è esattamente un agente che compila: un `cargo
 * build` o una suite di test occupano più core con un albero di processi, ed è
 * quella la forma che si riproduce qui.
 */
function caricoNostro(agenti: number, perAgente: number): { procs: Bun.Subprocess[]; spegni: () => void } {
  const script = `
    pids=''
    for i in $(seq 1 ${perAgente}); do
      ( while :; do :; done ) &
      pids="$pids $!"
    done
    trap 'kill $pids 2>/dev/null; exit 0' TERM INT
    ( sleep ${AUTO_SPEGNIMENTO_S}; kill $pids 2>/dev/null; kill $$ 2>/dev/null ) &
    wait
  `;
  const procs = Array.from({ length: agenti }, () =>
    Bun.spawn(["/bin/sh", "-c", script], { stdout: "ignore", stderr: "ignore" }));
  return {
    procs,
    spegni: () => { for (const p of procs) { try { p.kill("SIGTERM"); } catch { /* già morto */ } } },
  };
}

const riga = (m: Misura) =>
  `  ${m.gamba.padEnd(16)} tetto ${String(m.tetto).padStart(2)}` +
  `   (vecchio conto: ${m.tettoVecchio})` +
  `   nostri ${m.nostriCore == null ? "n/d" : m.nostriCore.toFixed(2)} core` +
  `   load ${m.load1.toFixed(1)}   agent vivi ${m.running}`;

async function main(): Promise<number> {
  const warmup = Number.parseInt(arg("warmup") ?? String(WARMUP_DEFAULT_S), 10);
  const strutturale = structuralDispatchCapacity();
  console.log(`Banco del freno del dispatch — ${CORES} core, tetto strutturale ${strutturale}, riscaldamento ${warmup}s per gamba.`);
  if (strutturale < 3) {
    console.log(`Questa macchina regge ${strutturale} agenti in regime: la prima gamba della barra (>= 3) non è misurabile qui.`);
    return 2;
  }

  const misure: Misura[] = [];
  const aRiposo = await misura("a riposo", 0);
  misure.push(aRiposo);
  console.log(riga(aRiposo));

  // ── Gamba 1: la macchina è satura, ma non per colpa nostra ────────────────
  const altrui = caricoAltrui();
  let gamba1: Misura;
  try {
    console.log(`  carico altrui:   ${altrui.pids.length} processi \`yes\` fuori dal nostro albero, ${warmup}s...`);
    await attesa(warmup * 1000);
    gamba1 = await misura("carico ALTRUI", 0);
  } finally {
    altrui.spegni();
  }
  misure.push(gamba1);
  console.log(riga(gamba1));
  await attesa(5000); // la macchina si sgombra prima della gamba successiva

  // ── Gamba 2: il carico è NOSTRO, e il freno deve mordere ──────────────────
  const AGENTI = 2, PER_AGENTE = 3;
  const nostro = caricoNostro(AGENTI, PER_AGENTE);
  let gamba2: Misura;
  try {
    console.log(`  carico nostro:   ${AGENTI} agent con ${PER_AGENTE} bruciatori l'uno, dentro l'albero della flotta, ${warmup}s...`);
    await attesa(warmup * 1000);
    gamba2 = await misura("carico NOSTRO", AGENTI);
  } finally {
    nostro.spegni();
  }
  misure.push(gamba2);
  console.log(riga(gamba2));

  // ── La barra ──────────────────────────────────────────────────────────────
  const esiti = [
    {
      barra: "carico ALTRUI: ne partono almeno 3",
      ok: gamba1.tetto >= 3,
      detta: `tetto ${gamba1.tetto} con la flotta a ${gamba1.nostriCore?.toFixed(2) ?? "n/d"} core e load ${gamba1.load1.toFixed(1)}`,
    },
    {
      barra: "carico NOSTRO: il freno morde ancora",
      ok: gamba2.tetto < strutturale,
      detta: `tetto ${gamba2.tetto} contro lo strutturale ${strutturale}, flotta a ${gamba2.nostriCore?.toFixed(2) ?? "n/d"} core`,
    },
  ];
  console.log("");
  for (const e of esiti) console.log(`  ${e.ok ? "OK  " : "ROTT"} ${e.barra} — ${e.detta}`);
  for (const m of misure) console.log(`  · ${m.gamba}: ${m.reason}`);

  const dove = arg("json");
  if (dove) {
    writeFileSync(dove, JSON.stringify({ cores: CORES, strutturale, warmup, misure, esiti }, null, 2));
    console.log(`\n  misure in ${dove}`);
  }
  return esiti.every((e) => e.ok) ? 0 : 1;
}

process.exit(await main());
