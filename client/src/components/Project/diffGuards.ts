import { ApiError } from '../../lib/api';
import type { GitFile } from '../../types';

/**
 * Quando NON si deve montare un diff, e cosa dire al posto suo.
 *
 * Due casi, tutt'e due scoperti misurando invece che immaginando.
 *
 * ── Il file troppo grande diventava «cancellato» ────────────────────────────
 * I due lati del diff vengono da rotte diverse con tetti diversi: `git show`
 * non ha limiti, `/api/files/content` taglia a 100 KB e risponde 413. Il client
 * inghiottiva quel 413 con un `catch` che scriveva stringa vuota, e il
 * MergeView disegnava fedelmente quello che gli era stato dato: a sinistra il
 * file, a destra il nulla. Cioè un file INTERAMENTE CANCELLATO, in rosso, che
 * non era vero. In questo repo 13 sorgenti stanno oltre il tetto — `server.ts`
 * è 191 KB — e sono file che si toccano di continuo.
 *
 * ── Il binario entrava come mojibake ────────────────────────────────────────
 * `git show` legge l'uscita come testo: un PNG da 10 KB diventa 19 KB di
 * caratteri di sostituzione, e CodeMirror li diffa riga per riga. Il flag c'è
 * già nel modello e l'altro renderer del repo (`Board/UnifiedDiff`) lo
 * consulta; è questo percorso che non lo guardava.
 */
export type DiffBlock =
  | { kind: 'too-large' }
  | { kind: 'binary' }
  | null;

/**
 * Il file è binario secondo git?
 *
 * Si guardano ENTRAMBI i lati e non quello del gruppo cliccato: un PNG appena
 * messo in stage ha il flag solo su `staged`, e chiedere il lato sbagliato lo
 * farebbe passare. Il flag manca del tutto sui non tracciati — git non li mette
 * in nessun diff, quindi non c'è niente da cui dedurlo — e quel caso lo prende
 * il controllo sul contenuto, `looksBinary`.
 */
export function isBinaryForDiff(file: GitFile | undefined): boolean {
  if (!file) return false;
  return Boolean(file.staged?.binary || file.unstaged?.binary);
}

/**
 * Ripiego per i binari che git non ha ancora classificato (i non tracciati).
 *
 * Il segnale è il carattere di sostituzione U+FFFD, che è ciò che resta di un
 * byte non decodificabile: un testo UTF-8 vero non ne contiene, nemmeno pieno
 * di accenti. Si guarda solo l'inizio perché basta, e perché scorrere venti
 * megabyte per rispondere «binario» sarebbe il costo che si vuole evitare.
 */
export function looksBinary(text: string, campione = 4096): boolean {
  const testa = text.slice(0, campione);
  if (!testa) return false;
  let sostituzioni = 0;
  for (let i = 0; i < testa.length; i++) {
    const c = testa.charCodeAt(i);
    if (c === 0xfffd || c === 0) sostituzioni++;
  }
  // Una soglia e non «almeno uno»: un file di testo può contenere un U+FFFD
  // legittimo (un documento che parla di codifiche, per dire).
  return sostituzioni / testa.length > 0.01;
}

/** Un errore di caricamento è il tetto dei 100 KB? */
export function isTooLarge(err: unknown): boolean {
  return err instanceof ApiError && err.status === 413;
}
