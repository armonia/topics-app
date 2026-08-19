/**
 * Cricchetto: il client NON possiede una copia delle ragioni della coda.
 *
 * La barra n.2 del task ha due metà. La prima — «la ragione arriva dal server
 * nel payload» — è provata dove il payload nasce
 * (`server/services/tasks.queue-reason.test.ts`). Questa è la seconda, quella
 * che nessun test del server può vedere: che da questo lato del filo nessuno la
 * ri-deduca. È il guasto già pagato col contatore «in attesa», ed è insidioso
 * perché una deduzione sbagliata non rompe niente: continua a rispondere, con
 * sicurezza, la regola di ieri.
 *
 * Cosa controlla: che nessun file sotto `client/src` scriva una delle frasi
 * della coda, e che il chip renda i campi del payload invece di comporli. Il
 * repo non ha un renderer di React nei test unitari, quindi il patto si tiene
 * sul SORGENTE — che è comunque il posto in cui si romperebbe: qualcuno
 * aggiunge un `task.dispatchAttempts >= 2 ? 'tentativi finiti' : …` e nessuno
 * se ne accorge finché una card non mente.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { deriveQueueReason } from '../../../../shared/board';

const SRC = resolve(import.meta.dir, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Dove una copia si anniderebbe davvero: i pezzi che disegnano una card e il
 * modulo che modella un task. Cercare le frasi in TUTTO `client/src` sembrava
 * più forte e invece è più debole: «nessun progetto» è una frase italiana
 * normale, il selettore dei progetti la usa per dire un'altra cosa, e tre
 * falsi positivi trasformano un cricchetto in rumore che si disattiva.
 */
const FILES = [...walk(join(SRC, 'components/Board')), join(SRC, 'lib/board.ts')];

/**
 * I commenti non sono un secondo autore della frase: spiegano quella del
 * server, e citarla per dire cosa succede e' il modo normale di scriverli. A
 * cercarla anche li' il cricchetto scatta su della prosa, e un cricchetto che
 * scatta a vuoto e' un cricchetto che qualcuno disattiva. Resta guardato il
 * posto in cui il guasto vive davvero: una stringa nel codice.
 */
function senzaCommenti(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * Le frasi, prese dalla funzione VERA e non ricopiate: un ramo nuovo entra in
 * questa lista da solo, e il giorno che qualcuno lo ricopia nel client il
 * cricchetto scatta senza che nessuno debba ricordarsi di aggiornarlo.
 */
const FRASI = [
  ['slot', {}, { ahead: 3 }],
  ['attempts', { dispatchAttempts: 9 }, {}],
  ['deferred', { dispatchDeferredUntil: '2026-08-12T10:12:00.000Z' }, {}],
  ['blocked', { blockedByTaskId: 'b1', blockedBy: { id: 'b1', text: 'x', status: 'todo', archived: false } }, {}],
  ['dispatch_off', {}, { autoDispatch: false }],
  ['no_project', {}, { projectless: true }],
  ['parent_review', { parentTaskId: 'p' }, { parentStatus: 'review' }],
  ['parent_turn', { parentTaskId: 'p' }, { parentStatus: 'in_progress' }],
  ['parent_idle', { parentTaskId: 'p' }, { parentStatus: 'done' }],
  ['checklist_frozen', { status: 'review' }, { openSubtasks: 2 }],
] as const;

const base = {
  status: 'todo', parentTaskId: null, dispatchState: null, dispatchAttempts: 0,
  dispatchDeferredUntil: null, blockedByTaskId: null, blockedBy: null,
};
const ctx = {
  now: '2026-08-12T10:00:00.000Z', autoDispatch: true, retryCap: 2, ahead: 0,
  parentStatus: null, projectless: false, openSubtasks: 0,
};

describe('la ragione della coda non ha una copia nel client', () => {
  test('nessun file di `client/src` scrive una delle frasi', () => {
    const colpevoli: string[] = [];
    for (const [kind, t, c] of FRASI) {
      const r = deriveQueueReason({ ...base, ...t }, { ...ctx, ...c })!;
      for (const file of FILES) {
        const src = senzaCommenti(readFileSync(file, 'utf8'));
        // `detail` è la parte che si vede sulla card: se una di queste stringhe
        // è scritta qui, la frase ha due autori e uno dei due sbaglierà.
        if (src.includes(r.detail)) colpevoli.push(`${relative(SRC, file)} scrive «${r.detail}» (${kind})`);
      }
    }
    expect(
      colpevoli,
      colpevoli.length
        ? `Il client si sta riscrivendo le ragioni della coda:\n  ${colpevoli.join('\n  ')}\n\n` +
          'La frase la compone il server (shared/board.deriveQueueReason, chiamata da rowToTask): ' +
          'qui si rende `task.queueReason`, non si deduce.'
        : '',
    ).toEqual([]);
  });

  test('il chip rende i campi del payload, non li compone', () => {
    const atoms = readFileSync(join(SRC, 'components/Board/atoms.tsx'), 'utf8');
    const chip = atoms.slice(atoms.indexOf('export function QueueReasonChip'));
    const corpo = chip.slice(0, chip.indexOf('\n}\n') + 1);
    expect(corpo).toContain('{reason.head}');
    expect(corpo).toContain('{reason.detail}');
    expect(corpo).toContain('title={reason.title}');
    // Il tono viene dal server: il colore è la distinzione «aspetta uno slot»
    // contro «non partirà mai», e dedurlo qui la rimetterebbe in mano al client.
    expect(corpo).toContain('QUEUE_TONE_CLS[reason.tone]');
    // Nessun ramo sui campi grezzi del task dentro il chip.
    expect(corpo).not.toMatch(/dispatchAttempts|dispatchDeferredUntil|blockedByTaskId|autoDispatch/);
  });

  test('la card e il drawer disegnano lo STESSO chip, con la stessa precedenza', () => {
    for (const f of ['components/Board/Card.tsx', 'components/Board/TaskDetail.tsx']) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, `${f} deve rendere il chip della ragione`).toContain('<QueueReasonChip reason={task.queueReason} />');
      // Prima del chip di stato: «in coda» è la parola che questo sostituisce.
      expect(src.indexOf('task.queueReason ?')).toBeLessThan(src.indexOf('DISPATCH_CHIP[task.dispatchState]'));
    }
  });
});
