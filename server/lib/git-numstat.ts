/**
 * Quante righe cambia ciascun file, non solo quali file cambiano.
 *
 * `git status` dice CHE COSA è cambiato, mai QUANTO: una riga toccata e un
 * rifacimento da mille righe arrivavano al pannello con lo stesso aspetto, e
 * per capire quale delle due fosse bisognava aprire il diff di ognuna. Il
 * conteggio viene da `git diff --numstat`, che è un comando a parte.
 *
 * ── Due diff, non uno ───────────────────────────────────────────────────────
 * `git diff` confronta albero di lavoro e INDICE; `--cached` confronta indice e
 * HEAD. Sono numeri diversi sullo stesso file, e il pannello mostra i file in
 * due gruppi che rispecchiano esattamente quella divisione. Un file può stare
 * in entrambi con conteggi diversi (staged 10 righe, poi altre 3 non staged),
 * quindi si tiene una mappa per lato invece di sommarle.
 *
 * ── `-z`, e il rename ha l'ordine ROVESCIATO ────────────────────────────────
 * Stesse ragioni di `git-porcelain.ts`: senza `-z` i path non-ASCII escono
 * citati e ottalizzati. Ma attenzione, l'output vero di git:
 *
 *     status --porcelain -z:   "R  rinominato.md\0da-rinominare.md\0"
 *     diff --numstat -z:       "0\t0\t\0da-rinominare.md\0rinominato.md\0"
 *
 * Nel primo viene prima il NUOVO path, nel secondo prima il VECCHIO. I due
 * comandi si contraddicono, e chi copia il parser dell'uno nell'altro aggancia
 * i conteggi al path sbagliato: su un rename il numero finirebbe su un file che
 * nella lista non c'è, e il file rinominato resterebbe senza. Qui la chiave è
 * sempre il path NUOVO, così combacia con quello che `parsePorcelainZ` mette in
 * `path`.
 *
 * Da notare anche la forma: dopo il secondo tab il campo path è VUOTO, e i due
 * path arrivano come campi NUL a sé stanti.
 *
 * ── Il binario non è «zero righe» ───────────────────────────────────────────
 * Un file binario esce `-\t-\t<path>`, non `0\t0`. Tradurlo in 0/0 direbbe «non
 * è cambiato niente» di un file che è cambiato del tutto, quindi si porta il
 * flag e il pannello scrive «bin» invece di due zeri.
 */

export interface Numstat {
  added: number;
  removed: number;
  /** git non conta le righe di un binario: `-`/`-`, non `0`/`0`. */
  binary?: boolean;
}

import { gitRead } from "./git-porcelain";

/** Albero di lavoro contro indice: le modifiche NON staged. */
export const NUMSTAT_ARGS = gitRead("diff", "--numstat", "-z", "--");
/** Indice contro HEAD: le modifiche staged. */
export const NUMSTAT_CACHED_ARGS = gitRead("diff", "--cached", "--numstat", "-z", "--");

/**
 * `git diff --numstat -z` → mappa path → conteggi.
 *
 * Il path di un rename è quello NUOVO (vedi sopra), così la chiave combacia con
 * quella di `parsePorcelainZ`.
 */
export function parseNumstatZ(text: string): Map<string, Numstat> {
  const out = new Map<string, Numstat>();
  const fields = text.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) continue;
    // `<add>\t<del>\t<path>` — con path vuoto se è un rename.
    const primo = rec.indexOf("\t");
    if (primo < 0) continue;
    const secondo = rec.indexOf("\t", primo + 1);
    if (secondo < 0) continue;
    const a = rec.slice(0, primo);
    const d = rec.slice(primo + 1, secondo);
    let path = rec.slice(secondo + 1);
    if (!path) {
      // Rename: due campi NUL a seguire, VECCHIO e poi NUOVO. Si tiene il
      // nuovo e si scarta il vecchio, ma vanno consumati entrambi o il record
      // dopo verrebbe letto come se fosse un path.
      i++; // vecchio
      path = fields[++i] ?? "";
      if (!path) continue;
    }
    const binary = a === "-" || d === "-";
    out.set(path, binary
      ? { added: 0, removed: 0, binary: true }
      : { added: parseInt(a, 10) || 0, removed: parseInt(d, 10) || 0 });
  }
  return out;
}

/**
 * Il conteggio di un file, tenendo conto che la lista può essere ristretta a
 * una sottocartella.
 *
 * `git diff` risponde sempre in path relativi alla RADICE del repo, mentre i
 * path della lista sono già stati accorciati da `scopeToPrefix`. Senza
 * rimettere il prefisso, in un progetto che è una sottocartella nessun file
 * troverebbe il suo numero e la colonna resterebbe vuota ovunque: un guasto
 * che si vede solo in quel caso, cioè quasi mai in prova.
 */
export function statOf(stats: Map<string, Numstat>, path: string, prefix: string): Numstat | undefined {
  return stats.get(prefix ? prefix + path : path);
}

/** Una voce di `git status` a cui si possono attaccare i conteggi. */
interface Contabile {
  path: string;
  status: string;
}

/** La stessa voce, dopo. I due campi li AGGIUNGE questa funzione. */
export type WithCounts<T> = T & { staged?: Numstat; unstaged?: Numstat };

/**
 * Oltre questa soglia i conteggi si saltano. Un `git diff` su una lista enorme
 * (un `node_modules` non ignorato, un reset che tocca tutto) costa quanto tutto
 * il resto della risposta messo insieme, e nessuno legge il «+3» della
 * quattromillesima riga. La lista arriva comunque: si perde il numero, non il
 * pannello.
 */
export const NUMSTAT_MAX_FILES = 400;

/**
 * I due diff, in parallelo. `stderr: "ignore"` e nessun throw: un repo appena
 * inizializzato non ha HEAD e `--cached` esce non-zero, il che non è un guasto
 * ma «non c'è ancora niente da confrontare».
 */
export async function readNumstats(cwd: string): Promise<{ staged: Map<string, Numstat>; unstaged: Map<string, Numstat> }> {
  const leggi = async (args: string[]) => {
    try {
      const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "ignore" });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      return proc.exitCode === 0 ? parseNumstatZ(text) : new Map<string, Numstat>();
    } catch {
      return new Map<string, Numstat>();
    }
  };
  const [unstaged, staged] = await Promise.all([leggi(NUMSTAT_ARGS), leggi(NUMSTAT_CACHED_ARGS)]);
  return { staged, unstaged };
}

/**
 * Attacca i conteggi alle voci, sul lato giusto.
 *
 * Il lato conta: il pannello mostra lo stesso file in due gruppi quando è
 * staged a metà, e mettere lo stesso numero da tutt'e due le parti direbbe che
 * le righe sono il doppio di quelle che sono. `status[0]` è l'indice,
 * `status[1]` l'albero di lavoro: si guarda quello, non la somma.
 */
export function attachNumstats<T extends Contabile>(
  entries: T[],
  stats: { staged: Map<string, Numstat>; unstaged: Map<string, Numstat> },
  prefix: string,
): WithCounts<T>[] {
  const out = entries as WithCounts<T>[];
  if (out.length > NUMSTAT_MAX_FILES) return out;
  for (const e of out) {
    // Non tracciato: git non lo mette in nessun diff, quindi non c'è numero da
    // dare. Meglio niente che uno zero, che direbbe «non è cambiato».
    if (e.status[0] !== " " && e.status[0] !== "?") {
      const s = statOf(stats.staged, e.path, prefix);
      if (s) e.staged = s;
    }
    if (e.status[1] !== " " && e.status[1] !== "?") {
      const u = statOf(stats.unstaged, e.path, prefix);
      if (u) e.unstaged = u;
    }
  }
  return out;
}
