import type { GitFile } from '../../types';

/**
 * Quali DUE cose si confrontano, aprendo un file dal pannello git.
 *
 * ── Il difetto ─────────────────────────────────────────────────────────────
 * C'era una coppia sola, per tutti: `HEAD` a sinistra e il file su disco a
 * destra. Quindi cliccare un file sotto «Staged» e cliccarlo sotto «Changes»
 * dava lo stesso identico diff — e non era nessuno dei due, era la SOMMA.
 *
 * Su un file con entrambe le colonne piene (`MM`) il pannello si contraddiceva
 * da solo: `LineStat` mostra numeri diversi per gruppo, e il diff accanto ne
 * mostrava un terzo. Non è un caso di laboratorio: è l'uscita garantita dello
 * staging per blocco di questo stesso pannello — metti in stage un blocco su
 * tre e il file È `MM`. Chi lo fa non poteva rispondere alla domanda che ci si
 * fa prima di ogni commit: «cosa sto per committare?».
 *
 * Ogni client git separa le due coppie: VS Code, GitKraken, Fork, Zed.
 *
 * ── E il rename ────────────────────────────────────────────────────────────
 * Il lato sinistro si chiedeva col nome NUOVO. `git show HEAD:<nuovo>` esce
 * non-zero — a HEAD quel nome non esisteva — e la rotta risponde 200 con corpo
 * vuoto: lato sinistro bianco, file intero in verde. Un rename di un file da
 * 9 KB con una riga cambiata si presentava come 9 KB di aggiunte. Il dato per
 * evitarlo c'era già nel modello (`origPath`), non arrivava fin qui.
 */

/** Un'estremità del confronto. */
export type DiffEnd =
  /** Il contenuto a una revisione: `git show <rev>:<file>`. */
  | { from: 'rev'; rev: string; path: string }
  /** Il contenuto dell'indice: `git show :0:<file>`. */
  | { from: 'index'; path: string }
  /** Il file com'è sul disco. */
  | { from: 'disk'; path: string };

export interface DiffEndpoints {
  left: DiffEnd;
  right: DiffEnd;
}

/** Da dove viene il diff che si sta aprendo. */
export type DiffSource =
  | { kind: 'worktree'; group: 'staged' | 'unstaged' | 'conflicted' }
  | { kind: 'commit'; hash: string };

/**
 * Le due estremità, dato il file e la provenienza.
 *
 * Il lato sinistro usa `origPath` quando c'è: è il nome che quel contenuto
 * aveva PRIMA, ed è l'unico con cui git sa trovarlo.
 */
export function diffEndpoints(file: Pick<GitFile, 'path' | 'origPath'>, source: DiffSource): DiffEndpoints {
  const nuovo = file.path;
  const vecchio = file.origPath || file.path;

  if (source.kind === 'commit') {
    // Il commit contro suo padre. Sul PRIMO commit del repo `<hash>^` non
    // esiste, `git show` esce non-zero e la rotta risponde vuoto: che è giusto,
    // un commit iniziale è tutto aggiunto.
    return {
      left: { from: 'rev', rev: `${source.hash}^`, path: vecchio },
      right: { from: 'rev', rev: source.hash, path: nuovo },
    };
  }

  if (source.group === 'staged') {
    // Cosa sto per committare: HEAD contro l'INDICE.
    return {
      left: { from: 'rev', rev: 'HEAD', path: vecchio },
      right: { from: 'index', path: nuovo },
    };
  }

  // Cosa NON ho ancora messo in stage: l'indice contro il disco.
  //
  // I conflitti stanno qui: il loro contenuto vive nell'albero di lavoro coi
  // marcatori, ed è quello che si vuole vedere. L'indice di un file in
  // conflitto non ha uno stage 0 — `git show :0:` fallisce — e la rotta
  // risponde vuoto, quindi il file appare come tutto aggiunto: è impreciso ma
  // non è una bugia sulla direzione, e mostrare i marcatori resta la cosa utile.
  return {
    left: { from: 'index', path: nuovo },
    right: { from: 'disk', path: nuovo },
  };
}

/** L'etichetta di un'estremità, per l'intestazione del diff. */
export function endLabel(end: DiffEnd): string {
  if (end.from === 'disk') return 'in lavorazione';
  if (end.from === 'index') return 'in stage';
  return end.rev === 'HEAD' ? 'HEAD' : end.rev.slice(0, 7);
}
