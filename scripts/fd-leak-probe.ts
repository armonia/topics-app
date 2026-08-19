/**
 * Sonda dei descrittori persi: `bun run probe:fdleak [--port 3333] [--n 500]
 * [--json] [--gate]`.
 *
 * Perche' esiste. Il server accumulava socket in stato CLOSED/CLOSE_WAIT che
 * tenevano il loro descrittore: sotto launchd, col tetto di sistema a 256, dopo
 * meno di un'ora accettava le connessioni nuove e le chiudeva subito dopo
 * l'handshake TLS senza morire e senza loggare niente. Dal di fuori: un server
 * vivo che non risponde. Il tetto e' stato alzato a 65536 in start-prod.sh, il
 * che rende il sintomo invisibile: ed e' proprio per questo che la misura deve
 * restare lanciabile, altrimenti una regressione torna muta.
 *
 * Cosa misura. Conta i descrittori del processo che ascolta sulla porta, spara
 * N richieste abortite a meta' (il client stacca prima della risposta, che e'
 * esattamente cio' che fa l'hook di Claude Code con `--max-time 2`), aspetta che
 * il kernel faccia decantare i TIME_WAIT e riconta. La differenza deve tornare
 * intorno a zero.
 *
 * Sola lettura sul server: l'unica rotta toccata e' una GET.
 */

/** Verdetto di una misura: quanti descrittori prima, quanti dopo, e se passa. */
export type FdVerdict = {
  before: number;
  after: number;
  delta: number;
  closed: number;
  closeWait: number;
  tolerance: number;
  ok: boolean;
};

/**
 * Il respiro naturale di un server vivo: fra le due misure possono nascere
 * connessioni vere (il guscio, un altro agente). Sotto questa soglia la
 * differenza non e' una perdita, sopra lo e'.
 */
export const DEFAULT_TOLERANCE = 10;

/** Decide se la differenza fra le due misure e' una perdita o il respiro normale. */
export function judge(
  before: number,
  after: number,
  closed: number,
  closeWait: number,
  tolerance = DEFAULT_TOLERANCE,
): FdVerdict {
  const delta = after - before;
  return { before, after, delta, closed, closeWait, tolerance, ok: delta <= tolerance };
}

/**
 * Estrae il pid dall'output di `lsof -nP -iTCP:<porta> -sTCP:LISTEN`.
 * La prima riga e' l'intestazione, il pid e' la seconda colonna.
 */
export function parseListenerPid(lsofOutput: string): number | null {
  const lines = lsofOutput.trim().split("\n").slice(1);
  for (const line of lines) {
    const pid = Number(line.trim().split(/\s+/)[1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * Conta i descrittori di un processo dall'output di `lsof -p <pid>`, e separa
 * i due stati che nella perdita crescevano da soli.
 */
export function countFds(lsofOutput: string): { total: number; closed: number; closeWait: number } {
  const lines = lsofOutput.trim().split("\n").filter((l) => l.length > 0);
  const body = lines.slice(1);
  let closed = 0;
  let closeWait = 0;
  for (const line of body) {
    if (line.includes("(CLOSED)")) closed++;
    if (line.includes("(CLOSE_WAIT)")) closeWait++;
  }
  return { total: body.length, closed, closeWait };
}

async function lsof(args: string[]): Promise<string> {
  const proc = Bun.spawn(["lsof", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

/**
 * Una richiesta abortita a meta': apre, non aspetta la risposta, stacca.
 * Riproduce il client che va in timeout, che e' il caso sospettato.
 */
async function abortedRequest(url: string, budgetMs: number): Promise<void> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budgetMs);
  try {
    await fetch(url, { signal: ctl.signal, tls: { rejectUnauthorized: false } } as RequestInit);
  } catch {
    // L'abort e' il comportamento voluto: e' la condizione che stiamo misurando.
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const arg = (name: string, fallback: string): string => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.split("=")[1] ?? fallback;
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--") ? argv[idx + 1] : fallback;
  };
  const port = Number(arg("port", "3333"));
  const n = Number(arg("n", "500"));
  const asJson = argv.includes("--json");
  const gate = argv.includes("--gate");

  const pid = parseListenerPid(await lsof(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]));
  if (pid === null) {
    console.error(`Nessun processo in ascolto su :${port}. Avvia il server e rilancia.`);
    process.exit(2);
  }

  const start = countFds(await lsof(["-p", String(pid)]));
  const url = `https://127.0.0.1:${port}/api/providers`;
  for (let i = 0; i < n; i++) await abortedRequest(url, 50);

  // Il kernel non libera i socket all'istante: senza questa attesa si misura
  // il TIME_WAIT, non la perdita.
  await Bun.sleep(10_000);
  const end = countFds(await lsof(["-p", String(pid)]));

  const verdict = judge(start.total, end.total, end.closed, end.closeWait);
  if (asJson) {
    console.log(JSON.stringify({ pid, port, requests: n, ...verdict }, null, 2));
  } else {
    console.log(`pid ${pid} su :${port}, ${n} connessioni abortite`);
    console.log(`descrittori: ${verdict.before} -> ${verdict.after} (delta ${verdict.delta})`);
    console.log(`CLOSED ${verdict.closed}, CLOSE_WAIT ${verdict.closeWait}`);
    console.log(verdict.ok ? "OK: nessuna perdita." : `PERDITA: +${verdict.delta} descrittori.`);
  }
  if (gate && !verdict.ok) process.exit(1);
}

if (import.meta.main) await main();
