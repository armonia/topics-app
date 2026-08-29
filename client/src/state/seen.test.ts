/**
 * La soglia fra SELEZIONARE e GUARDARE (FASE 2, AC a).
 *
 * Perché esiste. `sidebarRowCard` applica FOCUS WINS: la riga che stai guardando
 * torna neutra e non pulsa. La regola è giusta — non vuoi che ti lampeggi in
 * faccia ciò che stai leggendo — ma "stai guardando" voleva dire "è selezionata",
 * senza tempo. Un clic di passaggio per cercare un'altra tab spegneva il fill di
 * una chat mai letta, e nello stesso istante `clearUnreadFor` (agganciato al
 * frame 'focus' uscente in useWebSocket) ne azzerava l'unread. Le due cose
 * insieme sono il sintomo: "la tab non resta blu finché non la visualizzo".
 *
 * Qui si fissa la politica, che è pura e quindi provabile senza store né WS:
 * quanto deve durare lo sguardo, e quando un "visto" torna a valere zero.
 *
 * @covers TAB-BADGE-02, TAB-BADGE-07
 */
import { describe, test, expect } from 'bun:test';
import {
  SEEN_DWELL_MS,
  attentionFillFor,
  isSeen,
  resetSeenOnNewAttention,
  useSignalsStore,
} from './signals';

describe('isSeen — la soglia', () => {
  test('non davanti (null) non è mai visto, per quanto tempo passi', () => {
    expect(isSeen(null, 0)).toBe(false);
    expect(isSeen(null, 10_000_000)).toBe(false);
  });

  test('davanti da meno della soglia: NON visto — è il clic di passaggio', () => {
    const t0 = 1_000_000;
    expect(isSeen(t0, t0)).toBe(false);
    expect(isSeen(t0, t0 + 200)).toBe(false); // clic e via
    expect(isSeen(t0, t0 + SEEN_DWELL_MS - 1)).toBe(false);
  });

  test('davanti da almeno la soglia: visto', () => {
    const t0 = 1_000_000;
    expect(isSeen(t0, t0 + SEEN_DWELL_MS)).toBe(true);
    expect(isSeen(t0, t0 + SEEN_DWELL_MS + 5_000)).toBe(true);
  });

  test('la soglia è iniettabile, così un test non dipende dalla costante', () => {
    expect(isSeen(0, 300, 500)).toBe(false);
    expect(isSeen(0, 500, 500)).toBe(true);
  });

  test('la soglia sta fra il clic di passaggio e il ritardo percepibile', () => {
    // Non un numero magico: sotto ~600ms si torna al comportamento di prima,
    // sopra ~2s il fill sembra non cadere mai.
    expect(SEEN_DWELL_MS).toBeGreaterThanOrEqual(600);
    expect(SEEN_DWELL_MS).toBeLessThanOrEqual(2000);
  });
});

describe('resetSeenOnNewAttention — un nuovo "tocca a te" annulla il visto', () => {
  const S = (...ids: string[]) => new Set(ids);

  test('un id che ENTRA ora in awaiting perde il suo visto', () => {
    const next = resetSeenOnNewAttention(S('a', 'b'), S('b'), S('a', 'b'));
    // 'a' è appena entrato: il suo visto cade, e la tab torna blu.
    expect([...next].sort()).toEqual(['b']);
  });

  test('un id che RESTA awaiting mantiene il visto — lo stai leggendo adesso', () => {
    const prevSeen = S('a');
    const next = resetSeenOnNewAttention(prevSeen, S('a'), S('a'));
    // Nessun fronte di salita ⇒ stesso riferimento, nessun render.
    expect(next).toBe(prevSeen);
  });

  test('nessun cambiamento ⇒ STESSO riferimento (contratto anti-render)', () => {
    const prevSeen = S('a', 'b');
    expect(resetSeenOnNewAttention(prevSeen, S('a'), S('a'))).toBe(prevSeen);
    expect(resetSeenOnNewAttention(prevSeen, S(), S())).toBe(prevSeen);
    // Entra un id che non era visto: niente da togliere.
    expect(resetSeenOnNewAttention(prevSeen, S(), S('c'))).toBe(prevSeen);
  });

  test('un id che ESCE da awaiting non perde il visto (uscire non è un evento nuovo)', () => {
    const prevSeen = S('a');
    expect(resetSeenOnNewAttention(prevSeen, S('a'), S())).toBe(prevSeen);
  });

  test('secondo turno: visto → esce → rientra ⇒ il visto cade', () => {
    let seen: ReadonlySet<string> = S('a');
    seen = resetSeenOnNewAttention(seen, S('a'), S()); // turno finito, letto
    expect([...seen]).toEqual(['a']);
    seen = resetSeenOnNewAttention(seen, S(), S('a')); // nuovo turno finito
    expect([...seen]).toEqual([]);
  });

  test('più id insieme: solo i nuovi perdono il visto', () => {
    const next = resetSeenOnNewAttention(S('a', 'b', 'c'), S('a'), S('a', 'b', 'c'));
    expect([...next].sort()).toEqual(['a']);
  });
});

/**
 * The chat rising edge measures itself against ITS OWN previous set.
 *
 * A chat parked on an in-app `ask_user_question` never reaches an
 * awaiting-* phase (it stays tool-running), so it only ever shows up in
 * `awaitingInputTopics`. Feeding the union to `applyNewAttention` is what
 * lights the amber, but the comparison term has to be that same union, kept in
 * `attentionEdgeTopics`. Comparing against `awaitingFeedbackTopics` (the blue
 * "done" set, which the ask topic never enters) turns every pass into a fresh
 * rising edge: the amber would light and never go out again, not even after
 * you read the question. Hence the three-pass test below: a single pass would
 * pass with the broken version too.
 */
describe('applyNewAttention e una domanda aperta: si accende una volta, poi si spegne', () => {
  const S = (...ids: string[]) => new Set(ids);
  const reset = () => useSignalsStore.setState({
    seenSubjects: new Set(),
    awaitingFeedbackTopics: new Set(),
    awaitingInputTopics: new Set(),
    attentionEdgeTopics: new Set(),
  });
  const st = () => useSignalsStore.getState();
  const seen = () => st().seenSubjects;
  // One pass of useSignalsSync's effect: the union first, then the tier sets.
  const pass = (awaiting: Set<string>, input: Set<string>) => {
    st().applyNewAttention(new Set([...awaiting, ...input]));
    st().setTopicSet('awaitingFeedbackTopics', awaiting);
    st().setTopicSet('awaitingInputTopics', input);
  };

  test('la domanda arriva mentre la chat è vista ⇒ il visto cade (l ambra si accende)', () => {
    reset();
    st().markSubjectSeen('c1');
    pass(S(), S('c1'));
    expect(seen().has('c1')).toBe(false);
  });

  test('tre giri con la STESSA domanda aperta ⇒ il visto si azzera una volta sola', () => {
    reset();
    st().markSubjectSeen('c1');
    pass(S(), S('c1'));            // rising edge: seen cleared
    expect(seen().has('c1')).toBe(false);
    st().markSubjectSeen('c1');    // the human opens the chat and reads it
    pass(S(), S('c1'));            // same question still open
    pass(S(), S('c1'));
    expect(seen().has('c1')).toBe(true);
  });

  test('domanda chiusa e riaperta ⇒ nuovo fronte, il visto cade di nuovo', () => {
    reset();
    st().markSubjectSeen('c1');
    pass(S(), S('c1'));
    st().markSubjectSeen('c1');
    pass(S(), S());                // the answer closes the question
    expect(seen().has('c1')).toBe(true);
    pass(S(), S('c1'));            // a second question
    expect(seen().has('c1')).toBe(false);
  });

  test('niente cambia ⇒ stesso riferimento di seenSubjects (contratto anti-render)', () => {
    reset();
    pass(S('c1'), S());
    st().markSubjectSeen('c1');
    const before = seen();
    pass(S('c1'), S());
    expect(seen()).toBe(before);
  });
});

/**
 * Il fronte di salita vale anche per i TERMINALI.
 *
 * `applyNewAttention` annulla il visto delle CHAT, e per anni è stata l'unica
 * invalidazione: un terminale claude-code guardato una volta restava "visto" per
 * sempre, quindi al secondo turno finito la sua tab non tornava blu — e, da quando
 * il rollup di progetto salta i figli visti, lo stesso silenzio si propagava alla
 * tab del progetto. Per i terminali il reset sta DENTRO `setClaudePhaseTerminals`,
 * che è l'aggiornamento che ha già il precedente: così l'ordine non si può
 * sbagliare (per le chat è invece una chiamata separata, da fare prima).
 */
describe('setClaudePhaseTerminals — un terminale che rifinisce torna da guardare', () => {
  const S = (...ids: string[]) => new Set(ids);
  const reset = () => useSignalsStore.setState({
    seenSubjects: new Set(),
    claudePhaseActiveTermIds: new Set(),
    claudePhaseRestingTermIds: new Set(),
    claudePhaseAwaitingTermIds: new Set(),
    claudePhaseAwaitingInputTermIds: new Set(),
  });
  // Un terminale in attesa è anche "resting": qui conta solo l'insieme awaiting.
  const awaitingTerms = (ids: Set<string>) =>
    useSignalsStore.getState().setClaudePhaseTerminals(new Set(), new Set(ids), new Set(ids), new Set());
  const seen = () => useSignalsStore.getState().seenSubjects;

  test('finito → guardato → finito di nuovo ⇒ il visto cade', () => {
    reset();
    awaitingTerms(S('t1'));
    useSignalsStore.getState().markSubjectSeen('t1');
    expect(seen().has('t1')).toBe(true);
    awaitingTerms(S());        // riparte a lavorare
    expect(seen().has('t1')).toBe(true); // uscire non è un evento nuovo
    awaitingTerms(S('t1'));    // secondo turno finito
    expect(seen().has('t1')).toBe(false);
  });

  test('un terminale che RESTA in attesa mentre lo guardi non perde il visto', () => {
    reset();
    awaitingTerms(S('t1'));
    useSignalsStore.getState().markSubjectSeen('t1');
    awaitingTerms(S('t1', 't2')); // entra t2, t1 c'era già
    expect(seen().has('t1')).toBe(true);
  });

  test('niente cambia ⇒ stesso riferimento di seenSubjects (contratto anti-render)', () => {
    reset();
    awaitingTerms(S('t1'));
    useSignalsStore.getState().markSubjectSeen('t1');
    const before = seen();
    awaitingTerms(S('t1'));
    expect(seen()).toBe(before);
  });
});

describe('attentionFillFor — FOCUS WINS in un posto solo', () => {
  test('nessun tier ⇒ nessun fill, visto o no', () => {
    expect(attentionFillFor(null, false)).toBe(null);
    expect(attentionFillFor(null, true)).toBe(null);
    expect(attentionFillFor(undefined, false)).toBe(null);
  });

  test('tier presente e NON visto ⇒ il fill si mostra', () => {
    expect(attentionFillFor('done', false)).toBe('done');
    expect(attentionFillFor('input', false)).toBe('input');
  });

  test('tier presente e visto ⇒ niente fill: non pulsa ciò che stai guardando', () => {
    expect(attentionFillFor('done', true)).toBe(null);
    expect(attentionFillFor('input', true)).toBe(null);
  });

  test('il tier non viene mai riscritto: input resta input, done resta done', () => {
    // Regressione: il tier 'input' (ambra, "rispondi ora") è l'unico segnale
    // act-now dell'app. Un helper che lo declassasse a 'done' lo cancellerebbe.
    expect(attentionFillFor('input', false)).not.toBe('done');
  });
});
