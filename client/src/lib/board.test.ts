import { test, expect, describe } from 'bun:test';
import { blockedByChip, reopenedChip, boardIdForPath, diffTotals, hasCodeQuestion, isUnfinishedReview, nothingDeliveredWins, systemDeliveryChip, TASK_STATUSES, parseQuestionBlock, waitingOnThisChip, type BoardTask } from './board';

describe('boardIdForPath', () => {
  // Parity lock with the server (services/tasks.ts:projectIdForPath). Must stay
  // byte-identical or the client would address a different board than the API.
  test('exact output matches the server algorithm', () => {
    expect(boardIdForPath('/x/proj')).toBe('proj-xwac8t');
  });
  test('basename prefix + deterministic', () => {
    const a = boardIdForPath('/Users/utente/Projects/topics-app');
    expect(a).toBe(boardIdForPath('/Users/utente/Projects/topics-app'));
    expect(a.startsWith('topics-app-')).toBe(true);
  });
});

describe('TASK_STATUSES', () => {
  test('the five board columns in order', () => {
    expect(TASK_STATUSES).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
  });
});

describe('parseQuestionBlock', () => {
  test('parses a question with options', () => {
    const text = 'Un commento.\n\n```question\nQuale approccio auth?\n- JWT in cookie httpOnly\n- Bearer token breve\n```';
    expect(parseQuestionBlock(text)).toEqual({
      question: 'Quale approccio auth?',
      options: ['JWT in cookie httpOnly', 'Bearer token breve'],
    });
  });

  test('parses a question with no options (free-text only)', () => {
    expect(parseQuestionBlock('```question\nCome procedo?\n```')).toEqual({ question: 'Come procedo?', options: [] });
  });

  test('accepts * bullets and trims whitespace', () => {
    expect(parseQuestionBlock('```question\n  Scegli:\n  * A\n  * B\n```')).toEqual({ question: 'Scegli:', options: ['A', 'B'] });
  });

  test('returns null without a question block', () => {
    expect(parseQuestionBlock('solo un commento')).toBeNull();
    expect(parseQuestionBlock('')).toBeNull();
    expect(parseQuestionBlock('```\nnot a question fence\n```')).toBeNull();
  });

  test('returns null when the block has only options, no question', () => {
    expect(parseQuestionBlock('```question\n- A\n- B\n```')).toBeNull();
  });

  // The canonical form is server-composed (tasks service `questionOptions`),
  // but the parser must stay tolerant of hand-written LLM variants.
  test('parses the exact server-composed canonical form', () => {
    const text = '```question\nQuale approccio uso?\n- JWT in cookie\n- Bearer token\n```';
    expect(parseQuestionBlock(text)).toEqual({
      question: 'Quale approccio uso?',
      options: ['JWT in cookie', 'Bearer token'],
    });
  });

  test('tolerates CRLF newlines', () => {
    const text = '```question\r\nScelta?\r\n- A\r\n- B\r\n```';
    expect(parseQuestionBlock(text)).toEqual({ question: 'Scelta?', options: ['A', 'B'] });
  });

  test('tolerates a degenerate single-line block (lost newlines)', () => {
    const text = '```question Il task non ha descrizione: cosa faccio? - È un test - Va compilata```';
    expect(parseQuestionBlock(text)).toEqual({
      question: 'Il task non ha descrizione: cosa faccio?',
      options: ['È un test', 'Va compilata'],
    });
  });

  test('single-line block without options is a plain question', () => {
    expect(parseQuestionBlock('```question Come procedo?```')).toEqual({ question: 'Come procedo?', options: [] });
  });
});

describe('blockedByChip', () => {
  const chip = (over: Partial<BoardTask> = {}) =>
    blockedByChip({ blockedByTaskId: 'blk', blockedBy: null, ...over } as BoardTask);

  test('nessun link, nessun chip', () => {
    expect(chip({ blockedByTaskId: null })).toBeNull();
  });

  test('bloccante risolto: il titolo finisce nel chip', () => {
    expect(chip({ blockedBy: { id: 'blk', text: 'Rifai la scheda', status: 'todo', archived: false } }))
      .toEqual({
        label: 'aspetta: Rifai la scheda',
        title: 'Questa card aspetta «Rifai la scheda»: non parte finché quella non chiude.',
      });
  });

  // Il caso per cui esiste tutto questo: il bloccante non è nella lista fetchata
  // (sottotask, altro progetto, archiviato) e il server non ha potuto risolverlo.
  // Prima il chip spariva e la card sembrava libera; ora resta, degradato.
  test('titolo mancante: il chip resta, con il testo degradato', () => {
    const c = chip({ blockedBy: null });
    expect(c?.label).toBe('aspetta un altro task');
    expect(c?.title).toContain('non parte finché');
  });

  test('bloccante done: muto (il dispatcher lo farebbe partire)', () => {
    expect(chip({ blockedBy: { id: 'blk', text: 'Fatto', status: 'done', archived: false } })).toBeNull();
  });

  test('bloccante archiviato: muto', () => {
    expect(chip({ blockedBy: { id: 'blk', text: 'Archiviato', status: 'todo', archived: true } })).toBeNull();
  });
});

/**
 * IL CHIP CHE DICE «questo non l'ha consegnato l'agent».
 *
 * Esisteva dal 29/07 dentro il JSX della card, dove nessun test unitario lo
 * raggiungeva e nessun'altra superficie poteva riusarlo. Qui è una funzione pura
 * come `blockedByChip` e `reopenedChip`, e la stessa regola alimenta le SCELTE
 * (`isUnfinishedReview`): il chip e i bottoni non possono più dire due cose
 * diverse sulla stessa card, che è esattamente cosa succedeva il 13/08.
 */
describe('systemDeliveryChip', () => {
  const chip = (over: Partial<BoardTask> = {}) =>
    systemDeliveryChip({ status: 'review', deliveredBy: 'system', deliveredReason: null, ...over } as BoardTask);

  test('consegna dell\'agent: nessun chip', () => {
    expect(chip({ deliveredBy: 'agent' })).toBeNull();
    expect(chip({ deliveredBy: 'human' })).toBeNull();
    expect(chip({ deliveredBy: null })).toBeNull();
  });

  test('portata dal sistema: etichetta corta, ragione per esteso nel titolo', () => {
    const c = chip({ deliveredReason: 'retries_exhausted' });
    expect(c?.label).toBe('non consegnato');
    expect(c?.title).toContain('finito i tentativi');
  });

  test('ogni causa ha la sua parola: non un generico «chiuso dal sistema»', () => {
    const parole = (['retries_exhausted', 'model_refused', 'fanout', 'parked_children'] as const)
      .map((r) => chip({ deliveredReason: r })!.label);
    expect(new Set(parole).size).toBe(parole.length);
  });

  test('causa non registrata: il chip resta, degradato', () => {
    expect(chip({ deliveredReason: null })?.label).toBe('non consegnato');
  });

  test('fuori da review tace: su una card chiusa sarebbe archeologia', () => {
    expect(chip({ status: 'done' })).toBeNull();
    expect(chip({ status: 'in_progress' })).toBeNull();
  });
});

describe('isUnfinishedReview', () => {
  const su = (over: Partial<BoardTask> = {}) =>
    isUnfinishedReview({ status: 'review', deliveredBy: 'system', deliveredReason: 'retries_exhausted', ...over } as BoardTask);

  test('turno esaurito o modello che si rifiuta: nessuno ha consegnato', () => {
    expect(su()).toBe(true);
    expect(su({ deliveredReason: 'model_refused' })).toBe(true);
    expect(su({ deliveredReason: null })).toBe(true);
  });

  test('fan-out e figli parcheggiati no: hanno già la loro superficie', () => {
    expect(su({ deliveredReason: 'fanout' })).toBe(false);
    expect(su({ deliveredReason: 'parked_children' })).toBe(false);
  });

  test('una consegna vera non lo è mai, e fuori da review nemmeno', () => {
    expect(su({ deliveredBy: 'agent' })).toBe(false);
    expect(su({ deliveredBy: 'human' })).toBe(false);
    expect(su({ status: 'in_progress' })).toBe(false);
  });
});

describe('reopenedChip', () => {
  const chip = (over: Partial<BoardTask> = {}) =>
    reopenedChip({ reopenedAt: null, reopenedBy: null, reopenedActor: null, ...over } as BoardTask);

  test('mai uscita da done: nessun chip', () => {
    expect(chip()).toBeNull();
  });

  test('riaperta da un agent: il chip lo dice, e dice CHI', () => {
    const c = chip({ reopenedAt: '2026-08-11T09:30:00.000Z', reopenedBy: 'claude', reopenedActor: 'agent' });
    expect(c?.label).toBe('riaperta');
    expect(c?.title).toContain('agent');
    expect(c?.title).toContain('claude');
    // `detail` è la frase per la banda del drawer, che ha già «Riaperta» in
    // grassetto: se ripetesse il preambolo del tooltip sarebbe illeggibile.
    expect(c?.detail).toContain('agent');
    expect(c?.detail).not.toContain('Riaperta');
    expect(c?.detail).not.toContain('Era in Done');
  });

  test('riaperta dall’umano o dal sistema: stesso chip, autore diverso', () => {
    expect(chip({ reopenedAt: '2026-08-11T09:30:00.000Z', reopenedActor: 'human' })?.title).toContain('da te');
    expect(chip({ reopenedAt: '2026-08-11T09:30:00.000Z', reopenedActor: 'system' })?.title).toContain('dal sistema');
  });

  test('data illeggibile: il chip resta (non è il timestamp a doverlo tenere in piedi)', () => {
    const c = chip({ reopenedAt: 'non-una-data', reopenedActor: 'agent' });
    expect(c?.label).toBe('riaperta');
    expect(c?.title).toContain('non-una-data');
  });
});

describe('diffTotals', () => {
  const f = (additions: number, deletions: number) => ({ path: `f${additions}`, additions, deletions, status: 'M' });

  test('somma righe e conta i file', () => {
    expect(diffTotals([f(10, 2), f(3, 40)])).toEqual({ files: 2, additions: 13, deletions: 42 });
  });

  // git dà i binari come `-`, che il server porta a -1: contarli farebbe scendere
  // il totale sotto la somma vera, che è il modo peggiore di sbagliare un numero.
  test('un binario conta come FILE, mai come righe', () => {
    expect(diffTotals([f(5, 1), { path: 'logo.png', additions: -1, deletions: -1, status: 'A' }]))
      .toEqual({ files: 2, additions: 5, deletions: 1 });
  });

  test('nessun file: zeri, non NaN', () => {
    expect(diffTotals([])).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});

describe('hasCodeQuestion', () => {
  const t = (p: Partial<BoardTask>): BoardTask =>
    ({ assignedTopicId: null, deliveryBranch: null, deliveryCommit: null, status: 'backlog', ...p }) as BoardTask;

  test('una card di backlog che nessuno ha toccato non ha la domanda', () => {
    expect(hasCodeQuestion(t({}))).toBe(false);
    expect(hasCodeQuestion(t({ status: 'todo' }))).toBe(false);
  });

  test('un agente assegnato, o una consegna registrata, accendono il pannello', () => {
    expect(hasCodeQuestion(t({ assignedTopicId: 'topic-1' }))).toBe(true);
    expect(hasCodeQuestion(t({ deliveryBranch: 'topics/card' }))).toBe(true);
    expect(hasCodeQuestion(t({ deliveryCommit: 'abc123' }))).toBe(true);
  });

  // È il caso che conta: in review il silenzio era indistinguibile da «non ho
  // potuto guardare», e dopo il land il topic assegnato può non esserci più.
  test('review e done hanno SEMPRE la domanda, anche senza topic', () => {
    expect(hasCodeQuestion(t({ status: 'review' }))).toBe(true);
    expect(hasCodeQuestion(t({ status: 'done' }))).toBe(true);
  });
});

/**
 * I DUE VERSI DELL'ATTESA — il cricchetto che impedisce alla parola di tornare.
 *
 * Fino al 12/08 la stessa card diceva «in attesa di: X» e «3 in attesa», cioè
 * usava una parola sola per due fatti OPPOSTI: «io aspetto un altro» e «altri
 * tre aspettano me» (chiudere questa card ne sblocca tre). L'unico indizio era
 * il numero davanti, e la disambiguazione viveva nel tooltip: su un telefono,
 * nessuna.
 *
 * Qui si pinna la cosa più semplice e più difficile da tenere: che le due
 * frasi non condividano una parola piena. Un giorno qualcuno riscriverà una
 * delle due e la parola generica tornerà — questo test è quel giorno.
 */
describe('«io aspetto» e «altri aspettano me» non condividono una parola', () => {
  const parole = (s: string) =>
    new Set(
      s.toLowerCase().replace(/[«»:,.]/g, ' ').split(/\s+/)
        // Articoli e pronomi non contano: «la» sta in entrambe e non dice niente.
        .filter((w) => w.length > 2 && !['che', 'del', 'della', 'una', 'uno'].includes(w)),
    );

  test('le etichette dei due chip sono disgiunte', () => {
    const io = blockedByChip({
      blockedByTaskId: 'blk',
      blockedBy: { id: 'blk', text: 'Migrare le foto', status: 'todo', archived: false },
    } as BoardTask)!;
    const altri = waitingOnThisChip({ waitingOnCount: 3, status: 'todo' } as BoardTask)!;
    // Il titolo del bloccante non fa parte del vocabolario: è un dato.
    const mie = parole(io.label.replace('Migrare le foto', ''));
    const loro = parole(altri.label);
    const comuni = [...mie].filter((w) => loro.has(w));
    expect(comuni, `parole in comune fra i due versi: ${comuni.join(', ')}`).toEqual([]);
  });

  test('nessuna delle due usa più «in attesa», la parola ambigua', () => {
    const io = blockedByChip({ blockedByTaskId: 'blk', blockedBy: null } as BoardTask)!;
    const altri = waitingOnThisChip({ waitingOnCount: 2, status: 'todo' } as BoardTask)!;
    expect(io.label).not.toContain('in attesa');
    expect(altri.label).not.toContain('in attesa');
  });

  test('«altri aspettano me» si coniuga sul numero, e tace quando è chiusa', () => {
    expect(waitingOnThisChip({ waitingOnCount: 1, status: 'todo' } as BoardTask)?.label).toBe('1 la aspetta');
    expect(waitingOnThisChip({ waitingOnCount: 4, status: 'todo' } as BoardTask)?.label).toBe('4 la aspettano');
    expect(waitingOnThisChip({ waitingOnCount: 0, status: 'todo' } as BoardTask)).toBeNull();
    // Su una card chiusa il legame è già stato sciolto: dirlo sarebbe archeologia.
    expect(waitingOnThisChip({ waitingOnCount: 3, status: 'done' } as BoardTask)).toBeNull();
  });
});

describe('la non-consegna si dice UNA volta sola', () => {
  // `reviewEvidence(...).kind === 'empty'` pretende gia' `delivered_by =
  // 'system'` in review, che e' esattamente la condizione di
  // `systemDeliveryChip`: l'insieme e' contenuto, quindi senza una regola le
  // due chip escono SEMPRE insieme. Sulla card 5cf58e29 si leggeva «non
  // consegnato» accanto a «Niente consegnato», stesso ambra e stessa icona.
  const card = (deliveredReason: BoardTask['deliveredReason']) =>
    ({ status: 'review', deliveredBy: 'system', deliveredReason }) as BoardTask;

  test('esattamente una chip per ogni ragione di sistema', () => {
    const ragioni: BoardTask['deliveredReason'][] =
      [null, 'retries_exhausted', 'model_refused', 'fanout', 'parked_children'];
    for (const r of ragioni) {
      const t = card(r);
      // La card e' `empty` (nessun ramo, un agente c'e' stato): e' il caso in
      // cui le due chip si sovrapponevano.
      const senzaConsegna = nothingDeliveredWins(r);
      const systemDelivered = senzaConsegna ? null : systemDeliveryChip(t);
      const disegnate = [senzaConsegna ? 'niente-consegnato' : null, systemDelivered ? 'system' : null].filter(Boolean);
      expect(disegnate, `ragione ${String(r)}: ne devono uscire una sola`).toHaveLength(1);
    }
  });

  test('le due ragioni che dicono le stesse parole cedono a «niente consegnato»', () => {
    // `SYSTEM_DELIVERY_CHIP.retries_exhausted` e' letteralmente «non
    // consegnato»: e' l'unica coppia in cui la chip generica non aggiunge nulla.
    expect(nothingDeliveredWins(null)).toBe(true);
    expect(nothingDeliveredWins('retries_exhausted')).toBe(true);
  });

  test('una ragione che aggiunge un fatto lo tiene', () => {
    // «agent bloccato» e «scegli il tentativo» dicono qualcosa che «niente
    // consegnato» non dice: la chip specifica vince, e resta una sola.
    for (const r of ['model_refused', 'fanout', 'parked_children'] as const) {
      expect(nothingDeliveredWins(r)).toBe(false);
      expect(systemDeliveryChip(card(r))).not.toBeNull();
    }
  });
});
