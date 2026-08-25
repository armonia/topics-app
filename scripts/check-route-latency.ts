#!/usr/bin/env bun
/**
 * check-route-latency.ts: RATCHET sulle latenze delle rotte calde.
 *
 * Lo stesso mestiere di `scripts/check-bundle-size.ts`, su un'altra grandezza:
 * quello mette un pavimento sotto i byte del bundle, questo sotto i
 * millisecondi delle quattro rotte che la app chiama di continuo. Finora sulla
 * latenza non c'era nessun cancello: una query che diventa N+1, un `readFileSync`
 * dentro un ciclo, una tabella che cresce senza indice non lo dice nessuno
 * finche' non lo dice un utente.
 *
 * LE QUATTRO ROTTE. Sono quelle che si pagano a ogni caricamento e a ogni
 * apertura di chat, non quelle che sembrano importanti:
 *
 *   topics             GET /api/topics, l'albero completo dei topic. La prima
 *                      chiamata di ogni avvio, e quella che cresce con l'uso.
 *   topic_messages     GET /api/topics/:id/messages?limit=200, la conversazione
 *                      di una sessione. Legge, filtra e affetta TUTTI i messaggi
 *                      della sessione per restituirne 200: e' la rotta dove una
 *                      regressione si sente davvero, perche' il costo cresce con
 *                      la lunghezza della chat.
 *   all_boards_tasks   GET /api/all-boards/tasks, il feed dei task di tutte le
 *                      board. La board lo richiama a ogni evento.
 *   dispatch_capacity  GET /api/system/dispatch-capacity: quasi zero lavoro
 *                      (legge core, RAM e load). Serve proprio per questo: e' la
 *                      misura del TUBO, cioe' di quanto costa una richiesta
 *                      prima di arrivare al gestore. Se peggiora lei, e'
 *                      peggiorato qualcosa a monte che le altre tre pagano tutte.
 *
 * COME MISURA, e perche' cosi'.
 *
 * · Server ISOLATO, non quello di produzione sulla 3333. Lo avvia lui con
 *   `scripts/start-test-server.sh`, su una porta derivata dal path del checkout
 *   e con un DB suo, buttato via alla fine. Misurare la 3333 vorrebbe dire
 *   misurare quanti agenti stanno girando in quel momento.
 *
 * · Corpus FISSO e seminato da zero. La latenza di `/api/topics` dipende da
 *   quanti topic ci sono: una baseline presa su un DB vuoto e confrontata con un
 *   DB pieno non vuol dire niente. Il corpus e' dichiarato qui sotto, e' scritto
 *   nella baseline, e il cancello RIFIUTA di confrontare se i due non coincidono.
 *
 * · MEDIANA, non media. Un giro lento capita sempre (GC, un altro processo che
 *   si sveglia, lo scheduler). Sulla media quel giro sposta il numero, sulla
 *   mediana no: serve che sia lenta META' delle chiamate perche' si muova.
 *
 * · DUE passate, e il cancello si controlla da solo. Le stesse chiamate vengono
 *   fatte due volte, in due gruppi separati. Se le due mediane della stessa
 *   rotta non si somigliano, questa macchina in questo momento non e' un
 *   ambiente di misura: esce 2 (NON CONFRONTABILE) invece di 1 (regressione).
 *   E' la stessa scelta di `check-bundle-size` quando trova due build
 *   sovrapposte in `public/`: dire "questa misura non vuol dire niente" invece
 *   di accusare l'ultimo commit. Un cancello che grida a caso viene spento.
 *
 * · Chiamate a giro (round robin), non 30 di seguito sulla stessa rotta: cosi'
 *   un rallentamento passeggero della macchina si spalma su tutte e quattro
 *   invece di incastrarne una sola.
 *
 * · Soglia doppia: percentuale E pavimento assoluto. Una rotta da mezzo
 *   millisecondo che va a otto decimi e' cresciuta del 60% e non e' successo
 *   niente. `floor_ms` assorbe il tremolio che nessuna percentuale puo'
 *   distinguere dal segnale. Questo cancello e' fatto per prendere il salto (la
 *   query che diventa N+1, il file letto dentro un ciclo: 5x, 50x), non la
 *   deriva di mezzo millisecondo. Chi vuole prendere anche quella deve prima
 *   dare al banco una macchina ferma, e questa non lo e'.
 *
 * · Ogni risposta viene GUARDATA, non solo cronometrata: 200 e forma attesa. Una
 *   404 e' velocissima, e un banco che cronometra 404 resta verde per sempre
 *   mentre la rotta non esiste piu'.
 *
 * · Il banco misura IL SERVER CHE HA AVVIATO LUI, e lo dimostra: `waitForPort` da
 *   solo e' contento se risponde CHIUNQUE, quindi un server rimasto vivo da una
 *   corsa precedente verrebbe cronometrato al posto di questo, contro la baseline
 *   di un altro codice. Due testimoni: EADDRINUSE nel log del figlio, e il gruppo
 *   di processi di chi ascolta sulla porta.
 *
 * · `--selftest` prova che il cancello sa diventare rosso, nello STESSO processo
 *   appena misurato: arma un guasto a caldo, rimisura, e pretende il rosso.
 *
 * Uso:
 *   bun run check:route-latency
 *   bun run check:route-latency -- --update-baseline     registra i numeri nuovi
 *   bun run check:route-latency -- --samples=25          piu' campioni, meno rumore
 *   bun run check:route-latency -- --selftest            prova che sa diventare rosso
 *   TOPICS_ROTTE_FAULT_MS=40 bun run check:route-latency    guasto armato dall'ambiente
 *
 * Uscite:  0 = dentro il budget · 1 = regressione · 2 = non misurabile
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolveBaselinePaths } from "./route-latency-baseline-pick";
import { connect } from "node:net";
import { cpus, loadavg } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Parte PURA: nessuna rete, nessun processo. E' quella che prova
// scripts/check-route-latency.test.ts, compreso il caso in cui deve dire rosso.
// ─────────────────────────────────────────────────────────────────────────────

export const ROUTE_KEYS = [
  "topics",
  "topic_messages",
  "all_boards_tasks",
  "dispatch_capacity",
] as const;
export type RouteKey = (typeof ROUTE_KEYS)[number];

/**
 * La rotta che fa da METRO alla macchina, non al prodotto.
 *
 * `dispatch_capacity` legge core, RAM e load e basta: il suo numero e' il costo
 * di una richiesta PRIMA di arrivare al gestore. Quando lei e' fuori scala,
 * ogni altra cifra della stessa corsa se lo porta dentro, e non c'e' modo di
 * distinguere una macchina lenta da una regressione a monte. Vedi il controllo
 * in fondo a `main()`.
 */
export const CALIBRATION_KEY: RouteKey = "dispatch_capacity";

/**
 * Il tubo e' fuori scala? Se si', questa corsa non misura il prodotto.
 *
 * Pura e a parte perche' e' la decisione che va provata nei DUE versi: che scatti
 * quando il metro e' saltato, e che NON scatti quando il metro sta a posto, cosi'
 * una rotta che peggiora da sola continua a uscire rossa. Provarla dal banco vero
 * richiederebbe una macchina lenta a comando.
 *
 * Torna `null` quando si puo' misurare, altrimenti il numero misurato e il suo
 * tetto, cioe' quello che serve per scrivere il messaggio.
 */
export function calibrationOutOfScale(
  measured: Record<RouteKey, number>,
  baseline: Baseline,
): { measuredMs: number; capMs: number; baselineMs: number } | null {
  const baselineMs = baseline.routes[CALIBRATION_KEY].median_ms;
  const capMs = budgetMs(baselineMs, baseline.tolerance_pct, baseline.floor_ms);
  const measuredMs = measured[CALIBRATION_KEY];
  if (measuredMs > capMs) return { measuredMs, capMs, baselineMs };
  /**
   * …e il metro si legge anche in RAPPORTO, non solo contro il suo tetto.
   *
   * Il tetto e' `baseline +60%` OPPURE `+1,5 ms`, il piu' generoso. Su una
   * baseline piccola vince il pavimento assoluto, enorme in rapporto: 0,18 ms di
   * baseline con tetto 1,68 sono 9,3 volte se stessa, contro le 3,0 di una rotta
   * da 0,75. Il metro piu' permissivo della corsa e' proprio il giudice.
   *
   * 2026-08-15, prima corsa su CI (prima il job si fermava su `check:deadcode`,
   * `bash -e`): il runner ha fatto `dispatch_capacity` 0,87 ms = 4,8x senza far
   * scattare la calibrazione (0,87 < 1,68), mentre `all_boards_tasks` a 4,1x, MENO
   * di quanto la macchina si fosse allargata, e' uscita rossa. 2,5x e non 1,6x:
   * sotto, una macchina un po' piu' lenta deve ancora dare un rosso.
   *
   * NON risolve il fondo: la baseline viene da un M2 Max e il runner e' una VM
   * condivisa, quindi in CI uscira' quasi sempre 2. E' onesto, non e' protezione:
   * per quella serve una baseline registrata SUL runner e scelta per macchina,
   * come fa la sonda della memoria coi suoi `memory-<piattaforma>-<data>.json`.
   */
  const RAPPORTO_MAX = 2.5;
  const rapporto = baselineMs > 0 ? measuredMs / baselineMs : 0;
  if (rapporto > RAPPORTO_MAX) {
    return { measuredMs, capMs: baselineMs * RAPPORTO_MAX, baselineMs };
  }
  return null;
}

export interface Corpus {
  topics: number;
  messages: number;
  tasks: number;
  /**
   * Characters of description per task. PART OF THE CONTRACT, like the counts:
   * the feed slices `description` in SQL (`PREVIEW_SQL_CHARS`), so a corpus whose
   * descriptions are shorter than the slice cannot see that slice change at all.
   * It was 156 until 2026-08-21, below both the old cut (240) and the new one
   * (800), and the constant moved between them without the bench noticing.
   */
  description_chars: number;
}

export interface Baseline {
  tolerance_pct: number;
  floor_ms: number;
  noise_guard_pct: number;
  samples: number;
  corpus: Corpus;
  routes: Record<RouteKey, {
    median_ms: number;
    /** Lo SCARTO fra le due passate quando la baseline e' stata scritta: e' il
     *  rumore vero di quella rotta su questa macchina, e da li' esce il suo
     *  pavimento (vedi `floorFor`). Assente sulle baseline vecchie: allora si
     *  ricade sul pavimento generale. */
    noise_ms?: number;
  }>;
}

/**
 * La mediana. Su un numero pari di campioni prende il piu' BASSO dei due
 * centrali invece di farne la media: qui i campioni sono millisecondi di una
 * distribuzione con la coda tutta a destra (niente e' piu' veloce del minimo,
 * tutto puo' essere piu' lento), e la media dei due centrali si lascia tirare
 * su dalla coda proprio come farebbe la media di tutti.
 */
export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("mediana di zero campioni");
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
}

/**
 * Il tetto per una rotta: la percentuale O il pavimento, quello che concede di
 * piu'. Senza il pavimento una rotta da mezzo millisecondo fallirebbe per il
 * tremolio dello scheduler; senza la percentuale una rotta da 200 ms potrebbe
 * raddoppiare senza che nessuno se ne accorga.
 *
 * IL PAVIMENTO E' PER-ROTTA E LO DETTA IL RUMORE, non una costante. Con 1,5 ms
 * uguali per tutti — la prima versione — il conto era questo: `/api/topics` sta
 * a 0,36 ms, quindi il tetto usciva 1,86 e la rotta poteva peggiorare 5,17
 * volte restando verde; `dispatch_capacity` a 0,18 ms arrivava a 9,33 volte. Un
 * pavimento assoluto su rotte sotto il millisecondo NON e' una soglia larga: e'
 * una soglia che non puo' scattare.
 *
 * Il rumore vero questo banco lo misura gia', ed e' lo scarto fra le due
 * passate: `noise_ms` nella baseline lo porta rotta per rotta. Il pavimento e'
 * il doppio di quello scarto, con un minimo di 0,05 ms perche' una rotta
 * perfettamente stabile non deve avere tetto zero. Su `/api/topics` (scarto
 * misurato 0,01 ms) il tetto scende da 1,86 a 0,58: da 5,17x a 1,6x.
 */
export function budgetMs(baseMs: number, tolerancePct: number, floorMs: number): number {
  return Math.max(baseMs * (1 + tolerancePct / 100), baseMs + Math.max(0.05, floorMs));
}

/** Il pavimento di UNA rotta: due volte il rumore che la sua misura ha mostrato. */
export function floorFor(baseline: Baseline, key: RouteKey): number {
  const noise = baseline.routes[key]?.noise_ms;
  return Math.max(0.05, typeof noise === "number" && Number.isFinite(noise) ? noise * 2 : baseline.floor_ms);
}

/** Arrotonda a 2 decimali: sotto il centesimo di ms non c'e' segnale. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Le due passate si somigliano? Se no la macchina si sta muovendo sotto la
 * misura, e nessuno dei due numeri e' confrontabile con una baseline presa
 * ieri. Stessa soglia doppia del budget, per lo stesso motivo.
 */
export function unstableRoutes(
  passA: Record<RouteKey, number>,
  passB: Record<RouteKey, number>,
  guardPct: number,
  floorMs: number,
): string[] {
  const out: string[] = [];
  for (const key of ROUTE_KEYS) {
    const a = passA[key];
    const b = passB[key];
    if (a === undefined || b === undefined) continue;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi > budgetMs(lo, guardPct, floorMs)) {
      out.push(`${key}: passata 1 ${round2(a)} ms, passata 2 ${round2(b)} ms`);
    }
  }
  return out;
}

/**
 * Il corpus misurato e' quello della baseline? Se no il confronto e' fra due
 * cose diverse e va fermato prima di dire qualsiasi cosa: e' il modo piu'
 * facile di scrivere in una baseline un numero preso su un database vuoto.
 */
export function corpusMismatch(measured: Corpus, base: Corpus): string | null {
  const diffs = (Object.keys(base) as Array<keyof Corpus>)
    .filter((k) => measured[k] !== base[k])
    .map((k) => `${k}: misurato ${measured[k]}, baseline ${base[k]}`);
  return diffs.length ? diffs.join("; ") : null;
}

/** Le rotte peggiorate oltre il budget. Vuoto = verde. */
export function regressions(
  measured: Record<RouteKey, number>,
  baseline: Baseline,
): string[] {
  const out: string[] = [];
  for (const key of ROUTE_KEYS) {
    const got = measured[key];
    const base = baseline.routes[key]?.median_ms;
    // FALLIRE CHIUSO. Prima qui c'era `if (base === undefined) continue`, e
    // bastava rinominare una chiave, metterla a null o QUOTARE il numero
    // ("0.36") perche' quella rotta smettesse di essere giudicata e il cancello
    // uscisse 0. Una baseline che non si sa leggere non e' «nessuna
    // regressione»: e' un cancello disarmato, e va detto a voce alta.
    if (typeof base !== "number" || !Number.isFinite(base)) {
      out.push(`${key}: la baseline non porta un numero leggibile (${JSON.stringify(base)}): il cancello non puo' giudicare questa rotta`);
      continue;
    }
    if (got === undefined) {
      out.push(`${key}: non misurata in questo giro, e la baseline la dichiara: o si misura o si toglie dalla baseline`);
      continue;
    }
    const cap = budgetMs(base, baseline.tolerance_pct, floorFor(baseline, key));
    if (got > cap) {
      out.push(
        `${key}: ${round2(got)} ms > ${round2(cap)} ms ` +
          `(baseline ${round2(base)} ms +${baseline.tolerance_pct}% o +${round2(floorFor(baseline, key))} ms di rumore)`,
      );
    }
  }
  return out;
}

/**
 * La porta del banco, derivata dal path del checkout.
 *
 * Non un numero fisso: due worktree che lanciano il banco insieme si
 * ammazzerebbero il server a vicenda, ed e' un guasto gia' pagato dalla suite
 * E2E (il perche' per esteso sta in tests/e2e/helpers/worktree-port.ts). La
 * banda 15200-15299 sta fuori sia dalla 13334 e dalla finestra 13500-13899
 * degli shard, sia dai loro tunnel (+1000), sia dalla 3333 di produzione.
 */
export const ROUTE_BENCH_PORT_BASE = 15200;
export const ROUTE_BENCH_PORT_SPAN = 100;

export function benchPortFor(checkoutRoot: string): number {
  let h = 0x811c9dc5;
  const key = checkoutRoot.replace(/\/+$/, "");
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ROUTE_BENCH_PORT_BASE + ((h >>> 0) % ROUTE_BENCH_PORT_SPAN);
}

// ─────────────────────────────────────────────────────────────────────────────
// Il banco vero.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "..");

// Quale baseline si legge e quale si scrive: `route-latency-baseline-pick.ts`.
const { envKey: ENV_KEY, read: BASELINE_PATH, write: BASELINE_WRITE_PATH } =
  resolveBaselinePaths(REPO_ROOT, existsSync);

/**
 * Quanto materiale c'e' nel database mentre si misura. Cambiarlo INVALIDA la
 * baseline (il cancello se ne accorge da solo e lo dice): si cambia insieme al
 * numero, nello stesso commit.
 *
 * I numeri sono grossi APPOSTA. La prima taratura usava 24 topic, 300 messaggi
 * e 40 task: tutte e quattro le rotte rispondevano fra 0,18 e 0,64 ms, cioe'
 * dentro il rumore della macchina. Con una baseline li' sotto, il pavimento
 * assoluto (`floor_ms`) da solo concede quasi dieci volte il valore misurato, e
 * una rotta puo' peggiorare di brutto restando verde. Un cancello tarato su un
 * database giocattolo non e' un cancello: e' una misura di quanto costa il
 * `fetch`. Servono quantita' da utente vero, dove il costo del GESTORE supera
 * quello del tubo.
 */
const CORPUS: Corpus = { topics: 150, messages: 3000, tasks: 150, description_chars: 1200 };

/** Chiamate cronometrate per rotta e per passata. */
const DEFAULT_SAMPLES = 25;
/** Giri buttati via prima di cronometrare: la prima chiamata paga la cache fredda. */
const WARMUP = 5;

/**
 * Quanto carico per core si tollera mentre si REGISTRA una baseline.
 *
 * 0,5 non e' un numero di gusto: e' la meta' dei core occupati, cioe' il punto
 * oltre il quale su questo Mac la mediana ha iniziato a salire di un ordine di
 * grandezza (misurato: 0,75 -> 9,87 ms su `all_boards_tasks` con load 5,32 su
 * 12 core). Sul GIUDIZIO invece non si applica: li' un carico alto produce un
 * rosso, e un rosso in piu' si guarda, mentre una baseline gonfiata non si
 * guarda mai piu'.
 */
const MAX_LOAD_PER_CORE = 0.5;

/**
 * La macchina e' troppo carica per REGISTRARE una baseline? Pura, cosi' il caso
 * si prova senza dover davvero caricare un Mac: e' l'unico modo di vedere
 * questa guardia diventare rossa in un test.
 */
export function machineTooLoaded(load1: number, cores: number): boolean {
  const perCore = load1 / Math.max(1, cores);
  return Number.isFinite(perCore) && perCore > MAX_LOAD_PER_CORE;
}

interface Probe {
  key: RouteKey;
  path: string;
  /** Rifiuta una risposta che non e' quella attesa: una 404 e' velocissima. */
  ok: (body: any) => boolean;
}

function log(msg: string): void {
  console.log(msg);
}

function die(msg: string, code: 1 | 2): never {
  console.error(msg);
  process.exit(code);
}

/**
 * Who is listening on this port, by process group. It proves the server being measured is the
 * one just started: `waitForPort` alone is happy if ANYBODY answers, so a server left alive by a
 * previous run — or any unrelated service that happened to grab the port — gets timed in its
 * place, against a baseline recorded for different code. The failure is silent and looks exactly
 * like a regression.
 *
 * Returns null when it could not be established (no `lsof`): the bench then says so out loud
 * instead of pretending it checked.
 */
function listenerPgids(port: number): number[] | null {
  const lsof = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (lsof.error || lsof.status !== 0 || !lsof.stdout.trim()) return null;
  const pids = lsof.stdout.trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (pids.length === 0) return null;
  const out: number[] = [];
  for (const pid of pids) {
    const ps = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
    if (ps.error || ps.status !== 0) return null;
    const pgid = Number(ps.stdout.trim());
    if (!Number.isInteger(pgid)) return null;
    out.push(pgid);
  }
  return out;
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const open = await new Promise<boolean>((res) => {
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        res(true);
      });
      socket.on("error", () => res(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        res(false);
      });
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function api(base: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Esegue i lavori a gruppi: seminare 300 messaggi uno alla volta costa piu' del banco. */
async function inBatches<T>(items: T[], size: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map((it, j) => fn(it, i + j)));
  }
}

async function seed(base: string): Promise<{ topicId: string }> {
  // PRIMA di creare qualsiasi task: l'interruttore dell'auto-dispatch e' GLOBALE
  // (riga '*' di board_settings, ci si arriva da qualunque board). Senza questo
  // il banco creerebbe 40 task che il server prova a dispacciare come agenti
  // veri: il "carico" misurato sarebbe il suo.
  await api(base, "/api/boards/bench-route-latency/settings", {
    method: "PATCH",
    body: JSON.stringify({ autoDispatch: false, maxAgents: 1 }),
  });

  const topicIds: string[] = [];
  await inBatches(
    Array.from({ length: CORPUS.topics }, (_, i) => i),
    8,
    async (i) => {
      const t = await api(base, "/api/topics", {
        method: "POST",
        body: JSON.stringify({ name: `Route bench ${String(i).padStart(3, "0")}` }),
      });
      topicIds.push(t.id);
    },
  );

  // Il topic misurato e' il PRIMO creato, non uno a caso: la mediana di
  // `topic_messages` dipende da quanti messaggi ha la sessione, e deve essere
  // sempre lo stesso numero fra una run e l'altra.
  const first = await api(base, "/api/topics");
  const sorted = Object.values(first.topics as Record<string, any>).sort((a: any, b: any) =>
    String(a.name).localeCompare(String(b.name)),
  );
  const target = sorted[0] as any;

  await inBatches(
    Array.from({ length: CORPUS.messages }, (_, i) => i),
    16,
    async (i) =>
      void (await api(base, "/api/test/seed-message", {
        method: "POST",
        body: JSON.stringify({
          sessionKey: target.sessionKey,
          role: i % 2 === 0 ? "user" : "assistant",
          // Un contenuto realistico: la rotta serializza cio' che trova, e
          // misurarla su stringhe di tre lettere misurerebbe un'altra cosa.
          content: `Messaggio ${i} del banco. `.repeat(12),
          sortOrder: i,
        }),
      })),
  );

  await inBatches(
    Array.from({ length: CORPUS.tasks }, (_, i) => i),
    8,
    async (i) =>
      void (await api(base, "/api/boards/bench-route-latency/tasks", {
        method: "POST",
        body: JSON.stringify({
          text: `Task del banco numero ${i}`,
          // Long enough to exceed the SQL slice (`PREVIEW_SQL_CHARS`, 800), so a
          // change to that cut moves this number instead of hiding in it. Until
          // 2026-08-21 these were ~156 chars and the bench was blind to it.
          description: `Descrizione del task ${i}. `.repeat(
            Math.ceil(CORPUS.description_chars / 27),
          ),
        }),
      })),
  );

  return { topicId: target.id };
}

/** Conta cio' che c'e' davvero, per non certificare mai una misura su un DB vuoto. */
async function measuredCorpus(base: string, topicId: string): Promise<Corpus> {
  const topics = await api(base, "/api/topics");
  const msgs = await api(base, `/api/topics/${topicId}/messages?limit=200`);
  const tasks = await api(base, "/api/all-boards/tasks");
  return {
    topics: Object.keys(topics.topics ?? {}).length,
    messages: Number(msgs.total ?? 0),
    tasks: (tasks.tasks ?? []).length,
    // Declared, not measured: the feed returns `description_preview`, already
    // sliced, so the real length is not visible from here. This is what the
    // seeder wrote, and the seeder is the only thing that knows it.
    description_chars: CORPUS.description_chars,
  };
}

/**
 * Una passata: `samples` chiamate per rotta, a giro fra le rotte, con i primi
 * `WARMUP` giri buttati. Ritorna la mediana per rotta.
 */
async function runPass(base: string, probes: Probe[], samples: number): Promise<Record<RouteKey, number>> {
  const acc = new Map<RouteKey, number[]>(probes.map((p) => [p.key, []]));

  for (let round = 0; round < samples + WARMUP; round++) {
    for (const probe of probes) {
      const t0 = performance.now();
      const res = await fetch(`${base}${probe.path}`);
      const text = await res.text(); // il corpo va SCARICATO, o si cronometra mezza risposta
      const dt = performance.now() - t0;

      if (res.status !== 200) die(`✗ ${probe.path} ha risposto ${res.status}: la rotta non e' misurabile.`, 2);
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        die(`✗ ${probe.path} non ha risposto JSON: la rotta non e' misurabile.`, 2);
      }
      if (!probe.ok(body)) {
        die(
          `✗ ${probe.path} ha risposto 200 ma con la forma sbagliata.\n` +
            `  Una risposta vuota o d'errore e' VELOCE: cronometrarla darebbe verde a vuoto.`,
          2,
        );
      }

      if (round >= WARMUP) acc.get(probe.key)!.push(dt);
    }
  }

  const out = {} as Record<RouteKey, number>;
  for (const [key, xs] of acc) out[key] = median(xs);
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const update = args.includes("--update-baseline");
  // `--selftest`: prova che questo cancello SA diventare rosso. Vedi in fondo a main().
  const selftest = args.includes("--selftest");
  if (update && selftest) die("✗ --update-baseline e --selftest non stanno insieme: uno scrive la baseline, l'altro la usa per giudicare.", 2);
  const samples = Number(args.find((a) => a.startsWith("--samples="))?.split("=")[1]) || DEFAULT_SAMPLES;
  const portArg = Number(args.find((a) => a.startsWith("--port="))?.split("=")[1]);
  // LE `TOPICS_ROTTE_*` RESTANO COL NOME VECCHIO, ed e' una scelta.
  // `TOPICS_ROTTE_FAULT_MS` e `TOPICS_ROTTE_FAULT_PATH` non le legge questo file:
  // le legge `server/lib/route-fault.ts`, cioe' il server sotto misura. Sono un
  // contratto fra due processi, e rinominarle a meta' significa un guasto
  // sintetico che si arma qui e non si arma la'. Vanno rinominate tutte e tre
  // insieme, nello stesso edit che tocca `server/lib/route-fault.ts`.
  const port = portArg || Number(process.env.TOPICS_ROTTE_PORT) || benchPortFor(REPO_ROOT);

  // Nessun banco tocchera' mai il server vero: la 3333 e' il suo, e la sua
  // latenza dipende da quanti agenti stanno girando in quel momento.
  if (port === 3333) die("✗ La 3333 e' il server di produzione. Il banco misura solo un server suo.", 2);

  const faultMs = Number(process.env.TOPICS_ROTTE_FAULT_MS);
  const faulted = Number.isFinite(faultMs) && faultMs > 0;
  if (faulted) {
    const target = process.env.TOPICS_ROTTE_FAULT_PATH || "/api/topics";
    log(
      `⚠ GUASTO SINTETICO ARMATO: +${faultMs} ms su ${target} (TOPICS_ROTTE_FAULT_MS).\n` +
        `  Questa run serve a PROVARE che il cancello sa diventare rosso, non a misurare niente.`,
    );
    // La baseline non si registra mai da una misura truccata: sarebbe il modo
    // piu' rapido di rendere il cancello cieco per sempre.
    if (update) die("✗ --update-baseline e' rifiutato mentre il guasto e' armato.", 2);
  }

  if (!existsSync(BASELINE_PATH) && !update) {
    die(`✗ Manca ${BASELINE_PATH}. Registralo con: bun run check:route-latency -- --update-baseline`, 2);
  }

  const dataDir = `/tmp/topics-route-latency-bench-${port}`;
  rmSync(dataDir, { recursive: true, force: true }); // DB nuovo: il corpus dev'essere solo il nostro

  log(`Banco rotte · porta ${port} · DATA_DIR ${dataDir} · ${samples} campioni x 2 passate`);

  const child = spawn("bash", [resolve(REPO_ROOT, "scripts/start-test-server.sh")], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BUN_PORT: String(port),
      DATA_DIR: dataDir,
      TOPICS_HOME: `${dataDir}/.topics-home`,
      OPENCLAW_DIR: `${dataDir}/.openclaw`,
      // Socket dedicati: senza, il server del banco li deriverebbe dalla cwd,
      // che condivide con quello di sviluppo, e il suo riconcilio vedrebbe le
      // PTY vive dello sviluppo come orfane, ammazzandole.
      TOPICS_PTY_SOCKET: `/tmp/topics-pty-bridge-route-latency-${port}.sock`,
      TOPICS_AI_BRIDGE_SOCKET: `/tmp/topics-ai-bridge-route-latency-${port}.sock`,
      NO_TLS: "1",
      TOPICS_E2E: "1",
    },
  });
  let serverLog = "";
  child.stdout?.on("data", (d: Buffer) => { serverLog += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { serverLog += d.toString(); });

  // Una sola pulizia, agganciata anche a `exit`: `die()` esce con
  // `process.exit`, che NON fa girare i `finally`. Senza questo aggancio un
  // banco che si ferma a meta' lascerebbe un server vivo su quella porta, e la
  // run dopo troverebbe la porta occupata da se stessa.
  let cleaned = false;
  const stop = () => {
    if (cleaned) return;
    cleaned = true;
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* gia' morto */ }
    rmSync(dataDir, { recursive: true, force: true });
  };
  process.on("exit", stop);
  process.on("SIGINT", () => { stop(); process.exit(130); });

  let exitCode = 0;
  try {
    if (!(await waitForPort(port, 40_000))) {
      die(`✗ Il server del banco non si e' aperto sulla ${port} in 40s.\n${serverLog.slice(-1500)}`, 2);
    }

    // Is the thing answering actually OUR child? Two witnesses, neither costs anything.
    if (/EADDRINUSE/i.test(serverLog)) {
      die(`✗ Il server del banco ha detto EADDRINUSE sulla ${port}: sta rispondendo un altro processo.`, 2);
    }
    const pgids = listenerPgids(port);
    if (pgids === null) {
      log(`⚠ Non ho potuto leggere chi ascolta sulla ${port} (lsof assente): resta un testimone in meno.`);
    } else {
      const mine = child.pid ?? -1;
      const estranei = pgids.filter((g) => g !== mine);
      if (estranei.length > 0) {
        die(
          `✗ Sulla ${port} ascolta un processo che non e' del banco (gruppo ${estranei.join(", ")}, il mio e' ${mine}).\n` +
            `  Misurarlo vorrebbe dire confrontare la baseline di questo codice con un altro server.`,
          2,
        );
      }
    }

    const base = `http://127.0.0.1:${port}`;
    const { topicId } = await seed(base);

    const corpus = await measuredCorpus(base, topicId);
    log(`corpus         ${corpus.topics} topic · ${corpus.messages} messaggi · ${corpus.tasks} task`);
    const seedGap = corpusMismatch(corpus, CORPUS);
    if (seedGap) die(`✗ La semina non e' andata a buon fine (${seedGap}). Misura non valida.`, 2);

    const probes: Probe[] = [
      { key: "topics", path: "/api/topics", ok: (b) => Object.keys(b?.topics ?? {}).length === CORPUS.topics },
      {
        key: "topic_messages",
        path: `/api/topics/${topicId}/messages?limit=200`,
        ok: (b) => Array.isArray(b?.messages) && b.messages.length === 200 && b.total === CORPUS.messages,
      },
      { key: "all_boards_tasks", path: "/api/all-boards/tasks", ok: (b) => (b?.tasks ?? []).length === CORPUS.tasks },
      { key: "dispatch_capacity", path: "/api/system/dispatch-capacity", ok: (b) => typeof b?.recommended === "number" },
    ];

    const passA = await runPass(base, probes, samples);
    const passB = await runPass(base, probes, samples);
    // Fra le due passate si tiene la PEGGIORE: se una rotta e' lenta anche solo
    // in una delle due, e' lenta. Cosi' il banco non puo' guadagnarci a
    // ripetersi finche' non gli va bene.
    const measured = {} as Record<RouteKey, number>;
    for (const key of ROUTE_KEYS) measured[key] = Math.max(passA[key]!, passB[key]!);

    if (update) {
      const prev = existsSync(BASELINE_WRITE_PATH) ? JSON.parse(readFileSync(BASELINE_WRITE_PATH, "utf8")) : {};
      // Anche la REGISTRAZIONE passa dal controllo di stabilita'. Una baseline
      // presa su una macchina che tremava e' un numero gonfiato che poi nessuna
      // regressione riuscira' piu' a superare: il cancello resterebbe verde per
      // sempre senza che nessuno se ne accorga.
      const shaky = unstableRoutes(passA, passB, prev.noise_guard_pct ?? 60, prev.floor_ms ?? 1.5);
      if (shaky.length > 0) {
        die(
          `✗ Non registro una baseline da una misura instabile:\n  - ${shaky.join("\n  - ")}\n\n` +
            `  Un numero gonfiato qui rende il cancello cieco. Rilancia a macchina ferma.`,
          2,
        );
      }
      // NON SI REGISTRA UNA BASELINE DA UNA MACCHINA CARICA, ed e' un guasto
      // che ho riprodotto invece di temerlo: con `load average` a 5,32 su questo
      // Mac il banco ha scritto `all_boards_tasks` a 9,87 ms dove a macchina
      // ferma sta a 0,75 — tredici volte. Le due passate erano d'accordo, quindi
      // `unstableRoutes` taceva: il confronto A-contro-B vede il tremolio, non
      // il carico UNIFORME. Un numero cosi' non alza la soglia di un po', la
      // disarma per sempre.
      const cores = Math.max(1, cpus().length);
      const load1 = loadavg()[0] ?? 0;
      if (machineTooLoaded(load1, cores)) {
        log(`\n✗ Non registro una baseline con la macchina sotto carico:`);
        log(`  load average ${round2(load1)} su ${cores} core = ${round2(load1 / cores)} per core (tetto ${MAX_LOAD_PER_CORE}).`);
        log(`\n  A macchina carica i numeri escono gonfiati e concordi, quindi nessuna`);
        log(`  guardia se ne accorge. Aspetta che si calmi e rilancia.`);
        process.exitCode = 2;
        return;
      }
      const next = {
        ...prev,
        /** Sotto che carico e' stato preso questo numero: senza, «0,75 ms» non
         *  si sa se e' la rotta o la macchina. */
        taken_under: { load1: round2(load1), cores },
        $schema: "route-latency-baseline-v1",
        updated: new Date().toISOString().slice(0, 10),
        samples,
        tolerance_pct: prev.tolerance_pct ?? 60,
        floor_ms: prev.floor_ms ?? 1.5,
        noise_guard_pct: prev.noise_guard_pct ?? 60,
        corpus: CORPUS,
        // Accanto alla mediana si registra il RUMORE di quella rotta, cioe' lo
        // scarto fra le due passate di questo giro. E' il numero da cui esce il
        // suo pavimento: una rotta stabile prende un tetto stretto, una
        // ballerina se lo allarga da sola, e nessuna delle due dipende da una
        // costante scelta a mano.
        routes: Object.fromEntries(ROUTE_KEYS.map((k) => [k, {
          median_ms: round2(measured[k]!),
          noise_ms: round2(Math.abs((passA[k] ?? 0) - (passB[k] ?? 0))),
        }])),
      };
      writeFileSync(BASELINE_WRITE_PATH, `${JSON.stringify(next, null, 2)}\n`);
      for (const key of ROUTE_KEYS) log(`${key.padEnd(18)} ${round2(measured[key]!)} ms`);
      log(`\n✓ Baseline registrata in ${BASELINE_WRITE_PATH} (ambiente: ${ENV_KEY}).`);
      return;
    }

    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    // Quale baseline si sta confrontando: vedi `resolveBaselinePaths`.
    log(`baseline: ${basename(BASELINE_PATH)} (ambiente: ${ENV_KEY})`);

    const gap = corpusMismatch(CORPUS, baseline.corpus);
    if (gap) {
      die(
        `✗ Il corpus e' cambiato (${gap}): i numeri della baseline sono stati presi su un'altra\n` +
          `  quantita' di dati e non sono confrontabili. Rimisura con --update-baseline nello\n` +
          `  STESSO commit in cui hai cambiato il corpus.`,
        2,
      );
    }

    for (const key of ROUTE_KEYS) {
      const cap = budgetMs(baseline.routes[key]!.median_ms, baseline.tolerance_pct, baseline.floor_ms);
      log(
        `${key.padEnd(18)} ${String(round2(measured[key]!)).padStart(7)} ms   ` +
          `(passate ${round2(passA[key]!)} / ${round2(passB[key]!)} · baseline ${round2(baseline.routes[key]!.median_ms)} · tetto ${round2(cap)})`,
      );
    }

    const unstable = unstableRoutes(passA, passB, baseline.noise_guard_pct, baseline.floor_ms);
    if (unstable.length > 0) {
      console.error(
        `\n⚠ NON CONFRONTABILE: le due passate non si somigliano.\n  - ${unstable.join("\n  - ")}\n\n` +
          `Questa macchina si sta muovendo sotto la misura (agenti che girano, una build,\n` +
          `un'altra suite). Non e' una regressione e non viene chiamata tale: rilancia a\n` +
          `macchina ferma, o alza --samples.`,
      );
      exitCode = 2;
      return;
    }

    // ── IL TUBO E' IL METRO ──────────────────────────────────────────────────
    //
    // `dispatch_capacity` non e' una rotta come le altre: non fa quasi niente
    // (legge core, RAM e load), quindi il suo numero e' il costo di una
    // RICHIESTA prima di arrivare al gestore. Il commento in testa a questo file
    // lo dice gia': «se peggiora lei, e' peggiorato qualcosa a monte che le altre
    // tre pagano tutte». Fin qui pero' quel numero si stampava e basta.
    //
    // Serve perche' il controllo delle due passate non vede una macchina
    // UNIFORMEMENTE lenta: se il carico c'e' per tutta la corsa, le due passate
    // si somigliano benissimo e sono d'accordo su un numero che parla del
    // portatile. Misurato il 2026-08-14 su questa macchina, con Spotify, un
    // decoder video e due browser addosso: `all_boards_tasks` 8 ms contro una
    // baseline di 0,75, e lo stesso identico numero su un albero PRECEDENTE a
    // ogni modifica di quel giorno (8,68 ms). Non era una regressione, e il
    // cancello la chiamava cosi'.
    //
    // Quando il tubo sfonda il suo tetto nessun numero di quella corsa separa
    // «macchina lenta» da «regressione a monte»: sono la stessa curva. L'unica
    // risposta onesta e' 2, cioe' NON MISURABILE, che e' la stessa scelta di
    // `check:scroll-fluidity` con la sua calibrazione a riposo. Una rotta singola che
    // peggiora mentre il tubo sta a posto continua a uscire 1, ed e' provato dal
    // guasto sintetico (`TOPICS_ROTTE_FAULT_MS=40`).
    const pipe = calibrationOutOfScale(measured, baseline);
    if (pipe) {
      console.error(
        `\n⚠ NON MISURABILE: il tubo e' fuori scala.\n` +
          `  - ${CALIBRATION_KEY}: ${round2(pipe.measuredMs)} ms > ${round2(pipe.capMs)} ms ` +
          `(baseline ${round2(pipe.baselineMs)} ms)\n\n` +
          `Quella rotta non fa quasi niente: il suo numero e' il costo di una richiesta PRIMA\n` +
          `del gestore. Se e' fuori scala, ogni altra cifra di questa corsa la porta dentro, e\n` +
          `«macchina lenta» e «regressione a monte» diventano la stessa curva. Non si sceglie a\n` +
          `caso fra le due: si rimisura a macchina ferma. Se il tubo resta fuori scala anche li',\n` +
          `QUELLA e' la scoperta, e riguarda tutte e quattro le rotte insieme.`,
      );
      exitCode = 2;
      return;
    }

    const bad = regressions(measured, baseline);
    if (bad.length > 0) {
      console.error(
        `\n✗ Latenza fuori budget:\n  - ${bad.join("\n  - ")}\n\n` +
          `Le due passate sono d'accordo, quindi il numero e' vero. O si rimette a posto la\n` +
          `rotta, o, se il costo e' voluto, si alza la cifra in ${BASELINE_PATH}\n` +
          `nello STESSO commit, cosi' il diff dice cosa e' stato comprato.`,
      );
      exitCode = 1;
      return;
    }

    // ── L'AUTOPROVA ──────────────────────────────────────────────────────────
    //
    // Un cancello che nessuno ha mai visto fallire non e' un cancello. Qui la prova si fa nello
    // STESSO processo appena misurato: si arma un guasto di 40 ms sulle rotte dei topic, si
    // rimisura, e si pretende un rosso. Se resta verde, il cancello e' cieco — e lo dice invece
    // di lasciarti credere il contrario.
    //
    // Armare via ambiente non basterebbe: obbligherebbe a riavviare, e allora la misura sana e
    // quella guasta verrebbero da due processi diversi, che hanno numeri diversi comunque.
    if (selftest) {
      const arma = async (body: unknown) =>
        fetch(`${base}/api/test/route-fault`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const armed = await arma({ delayMs: 40, pathPrefix: "/api/topics" });
      if (!armed.ok) {
        die(`✗ Non ho potuto armare il guasto (${armed.status}): senza, l'autoprova non prova niente.`, 2);
      }
      log("\n▸ autoprova: guasto di 40 ms armato su /api/topics — mi aspetto un ROSSO.");
      const guastoA = await runPass(base, probes, samples);
      const guastoB = await runPass(base, probes, samples);
      const guasto = {} as Record<RouteKey, number>;
      for (const key of ROUTE_KEYS) guasto[key] = Math.max(guastoA[key]!, guastoB[key]!);
      await arma(null).catch(() => {});

      const rosso = regressions(guasto, baseline);
      for (const key of ROUTE_KEYS) {
        log(`  ${key.padEnd(18)} ${String(round2(guasto[key]!)).padStart(7)} ms (era ${round2(measured[key]!)})`);
      }
      if (rosso.length === 0) {
        console.error(
          `\n✗ AUTOPROVA FALLITA: con 40 ms di guasto su /api/topics il cancello e' rimasto VERDE.\n` +
            `  Vuol dire che i tetti sono cosi' larghi da non poter piu' vedere niente: una\n` +
            `  regressione vera passerebbe allo stesso modo. Il numero da guardare e'\n` +
            `  tolerance_pct in ${BASELINE_PATH}.`,
        );
        exitCode = 1;
        return;
      }
      log(`\n✓ Autoprova: il cancello e' diventato rosso su ${rosso.length} rotta/e. Sa mordere.`);
    }

    const won = ROUTE_KEYS.filter((k) => measured[k]! < baseline.routes[k]!.median_ms * 0.7);
    if (won.length > 0) {
      log(`\n✓ ${won.join(", ")}: oltre il 30% sotto la baseline. Abbassa il numero per bloccare il guadagno.`);
    }
    log("\n✓ Rotte dentro il budget.");
  } finally {
    stop();
    if (exitCode !== 0) process.exit(exitCode);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`✗ Il banco si e' rotto: ${err?.message ?? err}`);
    process.exit(2);
  });
}
