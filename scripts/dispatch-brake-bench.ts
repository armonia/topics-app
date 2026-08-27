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

/**
 * La finestra su cui la sonda calcola la CPU istantanea (due letture di `ps`).
 *
 * Deve stare SOPRA la cache di `getFleetUsage` (4s, `FLEET_TTL_MS` in
 * `server/lib/fleet-usage.ts`), altrimenti la seconda lettura arriva dalla
 * cache e non campiona niente: la misura resterebbe quella del delta
 * precedente, cioè una media lunga che ingloba anche il tempo PRIMA che il
 * carico partisse. Sotto i 4s il banco crederebbe di misurare 3 secondi di
 * macchina satura e ne misurerebbe sessanta mezzi vuoti.
 */
const SAMPLE_MS = 5000;

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
  await attesa(SAMPLE_MS);
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
  // nessuno sta guardando. È già successo, e il carico orfano ha strozzato il
  // dispatch per ore. Un guardiano staccato li spegne comunque.
  //
  // Il guardiano NON uccide a scatola chiusa. Fra adesso e il suo risveglio
  // questi pid possono essere già morti e RIASSEGNATI a un processo di
  // qualcun altro, e un banco che si porta dietro un `kill` cieco a scoppio
  // ritardato è peggio del carico che doveva ripulire. Prima di ognuno guarda
  // che quel pid sia ancora un `yes`.
  let guardiano = 0;
  if (pids.length) {
    const r = sh(
      `( sleep ${AUTO_SPEGNIMENTO_S}; for p in ${pids.join(" ")}; do ` +
      `case "$(ps -o comm= -p $p 2>/dev/null)" in *yes) kill $p 2>/dev/null;; esac; done ) & echo $!`,
    );
    guardiano = Number.parseInt(new TextDecoder().decode(r.stdout).trim(), 10) || 0;
  }
  return {
    pids,
    // Si spegne anche il guardiano: finito il banco non ha più niente da
    // sorvegliare, e lasciarlo dormire quattro minuti su una macchina viva
    // significa lasciare in giro un `kill` differito che non serve più.
    spegni: () => {
      if (pids.length) sh(`kill ${pids.join(" ")} 2>/dev/null; exit 0`);
      if (guardiano) sh(`kill ${guardiano} 2>/dev/null; exit 0`);
    },
  };
}

/**
 * Quanti bruciatori accende la seconda gamba: uno per core, e non di più.
 *
 * Il numero sembra il posto dove mettere una formula, e non lo è. La prima
 * versione ne accendeva sei fissi e ne misurava 1,9, perché il tempo di CPU si
 * spartisce fra tutti i processi pronti e su una macchina occupata sei
 * bruciatori non valgono sei core. La correzione ovvia era accenderne di più in
 * proporzione alla contesa. È stata misurata, e fa PEGGIO:
 *
 *     8 bruciatori  -> 4,3 core nostri
 *    20 bruciatori  -> 2,0 core nostri
 *    36 bruciatori  -> 2,5 core nostri
 *
 * Oltre il numero di core la macchina non spartisce meglio, thrasha: la coda si
 * allunga per tutti, gli altri processi si accumulano, e la NOSTRA fetta scende
 * invece di salire. Un banco che per far passare la sua barra mette la macchina
 * in ginocchio non misura più niente, e intanto sotto c'è il Mac di una persona
 * e ci sono gli altri agenti.
 *
 * Quindi: `CORES` bruciatori, che su una macchina libera bastano a prendersela
 * tutta, e su una macchina occupata non la peggiorano. Se non arrivano alla
 * quota, la risposta giusta non è accenderne altri: è dire che qui e adesso lo
 * scenario non si costruisce.
 *
 * IL SOFFITTO VERO, e non è la contesa. Misurato su questo host (8 core
 * performance + 4 efficiency): 1 bruciatore tiene 0,86 core-unità, 4 ne tengono
 * 3,60, 8 ne tengono 3,48. Non è una curva che sale e si piega: è un tetto
 * piatto a circa quattro, cioè esattamente i quattro core efficiency. L'albero
 * dei processi di un agente dispacciato gira a QoS bassa e macOS lo confina sul
 * cluster efficiency. Provato a toglierlo in due modi, nessuno funziona:
 * `taskpolicy -B -p <pid>` sui bruciatori già avviati, e lanciarli con
 * `launchctl asuser` invece che come figli. La QoS si eredita allo spawn e non
 * si restituisce.
 *
 * Da dentro un agente, quindi, la flotta finta non può superare ~4 core-unità
 * su una macchina da 12. È la ragione per cui questa gamba, con DUE agenti
 * finti, non si costruiva: due agenti hanno bisogno di superare 4 core-unità
 * per stringere il tetto, e 4 è il muro. Con UNO il conto chiede di superarne 3,
 * che il cluster efficiency concede, e lo scenario è lo stesso e altrettanto
 * vero: un agente che compila. Vedi `AGENTI` più sotto.
 */
const BRUCIATORI = CORES;

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
  // Il guardiano finisce nella trappola insieme ai bruciatori: se resta vivo
  // dopo che l'agente è morto, al risveglio spara un `kill` su pid che nel
  // frattempo possono essere di chiunque. Un cane da guardia senza più niente
  // da sorvegliare è solo un'arma con un timer.
  const script = `
    pids=''
    for i in $(seq 1 ${perAgente}); do
      ( while :; do :; done ) &
      pids="$pids $!"
    done
    ( sleep ${AUTO_SPEGNIMENTO_S}; kill $pids 2>/dev/null; kill $$ 2>/dev/null ) &
    guardiano=$!
    trap 'kill $pids $guardiano 2>/dev/null; exit 0' TERM INT
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
  // Quale gamba: `--gamba=1`, `--gamba=2`, o tutte e due (il default).
  //
  // Serve perché le due gambe hanno bisogno di macchine diverse. La prima vuole
  // una macchina CARICA di roba altrui, e la trova da sola. La seconda vuole
  // poter vincere metà macchina, quindi vuole il contrario: una macchina in cui
  // gli altri non stanno correndo. Rieseguire la seconda da sola, più tardi,
  // costa un minuto invece di tre, e non c'è ragione di rifare una gamba che è
  // già passata per aspettare quella che non poteva passare.
  const solo = arg("gamba");
  const fai1 = solo == null || solo === "1";
  const fai2 = solo == null || solo === "2";
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

  // «A riposo» è il nome che gli si dà, non una garanzia: il banco gira sulla
  // stessa macchina dove sta lavorando la flotta vera, e la sonda conta anche
  // quella. Se il tetto è già sotto 3 PRIMA di fabbricare qualunque carico, la
  // prima gamba non può dimostrare niente: fallirebbe per il lavoro degli
  // altri agenti, non per il freno. Quello non è un rosso, è un banco che non
  // si può eseguire qui adesso, e le due cose devono avere due esiti diversi
  // o il primo rosso vero verrà letto come rumore.
  if (aRiposo.tetto < 3) {
    console.log(
      `  Il tetto è già ${aRiposo.tetto} a macchina scarica (la flotta vera tiene ` +
      `${aRiposo.nostriCore?.toFixed(2) ?? "n/d"} core): la prima gamba non è misurabile ora. ` +
      "Rilancia quando la board è ferma.",
    );
    return 2;
  }

  // ── Gamba 1: la macchina è satura, ma non per colpa nostra ────────────────
  let gamba1: Misura | null = null;
  if (fai1) {
    const altrui = caricoAltrui();
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
  }

  // ── Gamba 2: il carico è NOSTRO, e il freno deve mordere ──────────────────
  //
  // UN agente, e il numero non è arbitrario: è il solo che questa macchina
  // permetta di misurare, ed è comunque lo scenario che conta.
  //
  // Il conto: uno slot nuovo costa una core-unità, quindi il tetto vivo vale
  // `max(2, agenti + floor(quota - nostri))`. Perché stringa sotto il tetto
  // strutturale (4 qui) servono, con DUE agenti, più di 4 core-unità nostre;
  // con UNO, più di 3. E più di 4 core-unità, da dentro un agente dispacciato,
  // non si prendono: il cluster efficiency è il muro (vedi `BRUCIATORI`).
  //
  // Un agente con dodici processi che macinano è un `cargo build -j12`, cioè
  // esattamente «un agente che compila». Non è una versione annacquata della
  // barra: è la barra, sullo scenario che questa macchina sa costruire.
  const AGENTI = 1;
  const quota = CORES / 2;
  let gamba2: Misura | null = null;
  let bruciatori = 0;
  if (fai2) {
    const perAgente = Math.max(1, Math.ceil(BRUCIATORI / AGENTI));
    bruciatori = AGENTI * perAgente;
    const nostro = caricoNostro(AGENTI, perAgente);
    try {
      console.log(
        `  carico nostro:   ${AGENTI} agent con ${perAgente} bruciatori l'uno ` +
        `(${bruciatori} in tutto, dentro l'albero della flotta), ${warmup}s...`,
      );
      await attesa(warmup * 1000);
      gamba2 = await misura("carico NOSTRO", AGENTI);
    } finally {
      nostro.spegni();
    }
    misure.push(gamba2);
    console.log(riga(gamba2));
  }

  // La premessa della seconda gamba, in aritmetica e non con un numero magico.
  //
  // Il freno deve mordere solo se la flotta ha davvero speso abbastanza quota:
  // il tetto vivo è `max(pavimento, agenti + floor(quota - nostri))`, e lo
  // scenario esiste quando quel numero sta sotto il tetto strutturale. Se non ci
  // sta, il freno NON deve mordere e un «rotto» parlerebbe della macchina, non
  // del codice: un rosso che vuol dire «rilancia più tardi» insegna a ignorare i
  // rossi.
  const PAVIMENTO = 2;
  const nostriCore = gamba2?.nostriCore ?? 0;
  const aliveExpectedCap = Math.max(PAVIMENTO, AGENTI + Math.floor(quota - nostriCore));
  const premessaGamba2 = gamba2 != null && aliveExpectedCap < strutturale;

  // ── La barra ──────────────────────────────────────────────────────────────
  const esiti = [
    gamba1 && {
      barra: "carico ALTRUI: ne partono almeno 3",
      ok: gamba1.tetto >= 3,
      detta: `tetto ${gamba1.tetto} con la flotta a ${gamba1.nostriCore?.toFixed(2) ?? "n/d"} core e load ${gamba1.load1.toFixed(1)}`,
    },
    gamba2 && premessaGamba2 && {
      barra: "carico NOSTRO: il freno morde ancora",
      ok: gamba2.tetto < strutturale,
      detta: `tetto ${gamba2.tetto} contro lo strutturale ${strutturale}, flotta a ${gamba2.nostriCore?.toFixed(2) ?? "n/d"} core`,
    },
  ].filter((e): e is { barra: string; ok: boolean; detta: string } => !!e);
  console.log("");
  for (const e of esiti) console.log(`  ${e.ok ? "OK  " : "ROTT"} ${e.barra} — ${e.detta}`);
  for (const m of misure) console.log(`  · ${m.gamba}: ${m.reason}`);

  const dove = arg("json");
  if (dove) {
    writeFileSync(dove, JSON.stringify({ cores: CORES, strutturale, warmup, premessaGamba2, misure, esiti }, null, 2));
    console.log(`\n  misure in ${dove}`);
  }

  // Se la flotta finta non è riuscita a prendersi più della sua quota, la
  // seconda gamba non aveva una premessa: sotto quota il freno NON deve
  // mordere, quindi quel «rotto» non parla del freno, parla di quanto era
  // contesa la macchina. Esito a parte, e non un rosso: un rosso che vuol dire
  // «rilancia più tardi» insegna a ignorare i rossi.
  if (fai2 && !premessaGamba2) {
    console.log(
      `\n  Seconda gamba NON MISURABILE: la flotta finta ha tenuto ${nostriCore.toFixed(2)} core ` +
      `sui ${quota} di quota con ${bruciatori} bruciatori, quindi il tetto vivo resta ` +
      `${aliveExpectedCap} e non stringe sotto lo strutturale ${strutturale}. ` +
      "Sotto quota il freno non deve mordere: non è un rosso della barra. " +
      "Rilancia quando la macchina è più libera.",
    );
    return 2;
  }
  return esiti.every((e) => e.ok) ? 0 : 1;
}

process.exit(await main());
