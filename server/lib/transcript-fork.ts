/**
 * transcript-fork.ts — "quale file continua QUESTA sessione?"
 *
 * Il tail di una sessione adottata segue un path fisso (`jsonl_path`). Finché
 * `claude --resume` riapre lo STESSO `<id>.jsonl` e ci appende (il caso comune,
 * misurato) va bene. Ma il resume può FORKARE: la CLI apre un `<nuovo-id>.jsonl`
 * ci ricopia dentro la storia del padre e prosegue lì. Il file vecchio smette di
 * crescere e chi lo tailla resta fermo per sempre — la chat si ricongela.
 *
 * La traccia per riagganciarsi è nei dati: il figlio COPIA le righe del padre
 * con i loro `uuid`. Quindi "il file che continua questa sessione" = un
 * transcript più recente, nella stessa cartella di progetto, che contiene gli
 * uuid che abbiamo già consumato. Il punto in cui la copia finisce è il punto
 * da cui riprendere a leggere: tutto ciò che sta prima l'abbiamo già importato.
 *
 * Misurato su ~/.claude/projects (11 cartelle, 3 fork reali trovati): il figlio
 * ricopia il prefisso del padre ma NON è una copia riga-per-riga —
 * intercala righe nuove (`attachment`, `file-history-*`, `mode`, `ai-title`)
 * che il padre non ha. Per questo il confronto non è in lockstep: si scorre il
 * figlio e si tiene l'offset dell'ULTIMA riga il cui uuid è già noto. Le righe
 * nuove intercalate non interrompono il riconoscimento, e la prima vera coda
 * inedita resta fuori dal cursore (verrà importata).
 */

import { promises as fsp } from 'fs';
import { basename, dirname, join } from 'path';

export interface ForkContinuation {
  /** Transcript che prosegue la sessione. */
  path: string;
  /** sessionId della continuazione = stem del file (`<uuid>.jsonl`). */
  sessionId: string;
  /** Offset in byte subito DOPO l'ultima riga già nota (dove riprendere). */
  offset: number;
  /** Quante righe già consumate il file ricopia — l'evidenza che è la nostra. */
  matched: number;
  /** mtime del candidato, per la cache dei rifiuti del chiamante. */
  mtimeMs: number;
}

export interface FindForkOptions {
  /** Transcript attualmente seguito (quello che non cresce più). */
  currentPath: string;
  /** Byte già consumati dal file corrente (`import_offset`). */
  consumedBytes: number;
  /**
   * "Questo path è già di un'ALTRA sessione tracciata": due topic nella stessa
   * cartella di progetto non devono rubarsi il transcript a vicenda.
   */
  isPathTaken?: (path: string) => boolean;
  /**
   * Cache dei rifiuti del chiamante: un candidato già scartato e non toccato da
   * allora non si riscansiona (evita di rileggere MB a ogni sweep).
   */
  skip?: (path: string, mtimeMs: number) => boolean;
  /** Quanti candidati al massimo (i più recenti). Default 6. */
  maxCandidates?: number;
  /** Non scansionare candidati più grandi di così. Default 64 MB. */
  maxScanBytes?: number;
  /** Quante righe ignote consecutive prima di dire "la copia è finita". Default 200. */
  divergenceRun?: number;
}

export interface FindForkResult {
  found: ForkContinuation | null;
  /** Candidati esaminati e scartati — il chiamante può metterli in cache. */
  rejected: Array<{ path: string; mtimeMs: number }>;
}

/** uuid della riga (campo di primo livello), o null se la riga non ne ha. */
function lineUuid(line: string): string | null {
  // Filtro a buon mercato prima di parsare: la maggior parte delle righe
  // "di servizio" (mode, permission-mode, queue-operation) non ha uuid.
  if (!line.includes('"uuid"')) return null;
  try {
    const o = JSON.parse(line) as { uuid?: unknown };
    return typeof o.uuid === 'string' && o.uuid.length > 0 ? o.uuid : null;
  } catch {
    return null;
  }
}

/**
 * Gli uuid delle righe già consumate del transcript corrente. Legge solo
 * `[0, consumedBytes)`: quello che non abbiamo importato non è "storia nota" e
 * non deve autorizzare un aggancio.
 */
export async function collectConsumedUuids(path: string, consumedBytes: number): Promise<Set<string>> {
  const out = new Set<string>();
  if (consumedBytes <= 0) return out;
  const fh = await fsp.open(path, 'r');
  try {
    const stat = await fh.stat();
    const len = Math.min(consumedBytes, stat.size);
    if (len <= 0) return out;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    for (const line of buf.toString('utf-8').split('\n')) {
      if (!line) continue;
      const u = lineUuid(line);
      if (u) out.add(u);
    }
  } finally {
    await fh.close();
  }
  return out;
}

/**
 * Scorre un candidato e restituisce l'offset subito dopo l'ULTIMA riga il cui
 * uuid è già noto, più quante ne ha riconosciute. `matched === 0` ⇒ non è la
 * continuazione di questa sessione.
 */
export async function scanCopiedPrefix(
  path: string,
  known: Set<string>,
  divergenceRun: number,
): Promise<{ offset: number; matched: number }> {
  const text = await fsp.readFile(path, 'utf-8');
  let offset = 0;       // byte consumati finora
  let lastEnd = 0;      // offset dopo l'ultima riga riconosciuta
  let matched = 0;
  let unknownRun = 0;
  let cursor = 0;
  while (cursor < text.length) {
    let nl = text.indexOf('\n', cursor);
    if (nl === -1) break; // riga parziale in coda: non la si conta
    const line = text.slice(cursor, nl);
    cursor = nl + 1;
    offset += Buffer.byteLength(line, 'utf-8') + 1;
    const u = lineUuid(line);
    if (!u) continue; // righe di servizio: non spostano né rompono nulla
    if (known.has(u)) {
      lastEnd = offset;
      matched += 1;
      unknownRun = 0;
    } else if (++unknownRun >= divergenceRun) {
      // Siamo abbondantemente oltre la copia: il resto è coda nuova.
      break;
    }
  }
  return { offset: lastEnd, matched };
}

/**
 * Cerca, nella cartella di progetto del transcript corrente, il file che
 * CONTINUA questa sessione dopo un fork. Restituisce anche i candidati scartati
 * perché il chiamante li ricordi e non li rilegga ogni sweep.
 */
export async function findForkContinuation(opts: FindForkOptions): Promise<FindForkResult> {
  const {
    currentPath,
    consumedBytes,
    isPathTaken,
    skip,
    maxCandidates = 6,
    maxScanBytes = 64 * 1024 * 1024,
    divergenceRun = 200,
  } = opts;
  const rejected: Array<{ path: string; mtimeMs: number }> = [];

  let curMtime: number;
  try {
    curMtime = (await fsp.stat(currentPath)).mtimeMs;
  } catch {
    // Il transcript corrente è sparito: senza i suoi uuid non c'è prova di
    // parentela, e agganciarsi "a naso" al file più recente della cartella
    // ruberebbe la sessione di qualcun altro. Meglio fermi.
    return { found: null, rejected };
  }

  const dir = dirname(currentPath);
  const self = basename(currentPath);
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return { found: null, rejected };
  }

  const candidates: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl') || name === self) continue;
    const p = join(dir, name);
    if (isPathTaken?.(p)) continue;
    let st;
    try { st = await fsp.stat(p); } catch { continue; }
    // Solo file più RECENTI del nostro: il fork nasce dopo che il padre si è
    // fermato. Un transcript più vecchio non può contenere la nostra coda.
    if (!st.isFile() || st.size === 0 || st.mtimeMs <= curMtime) continue;
    if (st.size > maxScanBytes) {
      // Niente tagli silenziosi: se un candidato è troppo grosso per essere
      // scansionato, si dice — altrimenti "non è un fork" e "non l'ho guardato"
      // sono indistinguibili.
      console.warn(`[transcript-fork] candidato saltato, ${st.size} byte > ${maxScanBytes}: ${p}`);
      continue;
    }
    if (skip?.(p, st.mtimeMs)) continue;
    candidates.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
  }
  if (candidates.length === 0) return { found: null, rejected };

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const short = candidates.slice(0, maxCandidates);

  if (consumedBytes > maxScanBytes) {
    console.warn(`[transcript-fork] transcript corrente troppo grande per cercare un fork (${consumedBytes} byte): ${currentPath}`);
    return { found: null, rejected };
  }
  const known = await collectConsumedUuids(currentPath, consumedBytes);
  if (known.size === 0) return { found: null, rejected };

  let best: ForkContinuation | null = null;
  for (const c of short) {
    let res: { offset: number; matched: number };
    try { res = await scanCopiedPrefix(c.path, known, divergenceRun); }
    catch { continue; }
    if (res.matched === 0 || res.offset === 0) {
      rejected.push({ path: c.path, mtimeMs: c.mtimeMs });
      continue;
    }
    // Più righe nostre ricopia, più è la nostra: a parità vince il più recente
    // (i candidati sono già ordinati per mtime discendente).
    if (!best || res.matched > best.matched) {
      if (best) rejected.push({ path: best.path, mtimeMs: best.mtimeMs });
      best = { path: c.path, sessionId: basename(c.path, '.jsonl'), offset: res.offset, matched: res.matched, mtimeMs: c.mtimeMs };
    } else {
      rejected.push({ path: c.path, mtimeMs: c.mtimeMs });
    }
  }
  return { found: best, rejected };
}
