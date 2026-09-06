import { useEffect, useMemo, useState } from 'react';
import { useT } from '../../hooks/useT';
import { clearAskDraft, readAskDraft, writeAskDraft } from './askDraft';
import { HelpCircle, Send, Loader2, ChevronRight, ArrowRight } from 'lucide-react';
import type { ToolUserResponse, UserInputSchema, AskUserQuestionItem } from '../../types';
import { isPlanApprovalSchema, PLAN_EDIT_KEY } from '../../../../shared/plan-decision';
import { Select } from '../Shared/Select';

/** Extract a human-readable message from a rejected submit. `onSubmit`
 *  rejects with `{ status, message }` on HTTP errors, but a thrown Error or
 *  anything else is possible — pull a `message` string when present. */
function errorMessage(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return undefined;
}

interface Props {
  /** The structured request the provider made. Shape is one of three
   *  flavours; the form renders accordingly. */
  schema: UserInputSchema;
  /** Submit handler. Resolved when the server confirms (200), rejected
   *  with `{ status, message }` on any 4xx/5xx so the form can keep
   *  state and surface the message inline. */
  onSubmit: (response: ToolUserResponse) => Promise<void>;
  /** Optional toolCallId for keying — only used to scope DOM ids so two
   *  parallel forms in split panes don't collide on `radio` names. */
  toolCallId: string;
  /**
   * The plan as the model proposed it, on a plan approval panel.
   *
   * Present only there, and only once the row holds the WHOLE text: the
   * history payload ships long strings cut to their head, so seeding the box
   * from a trimmed copy would offer a truncated plan for approval.
   */
  planText?: string;
}

/**
 * Inline form rendered inside `<ToolCallRow>` when the tool has
 * `status: 'waiting_for_input'`. Replaces the spinner with whichever
 * input shape the provider asked for (radio questions, JSON-Schema
 * elicitation, or a free-text fallback). On submit it POSTs to
 * `/api/chat/tool-response`; the WS broadcast that follows updates
 * `ToolCall.userResponse` so re-renders show the collapsed summary
 * instead of the form.
 *
 * Deliberately minimal: the form is one of the most visible UI
 * surfaces in the app and the failure mode (user can't answer the
 * agent) is severe, so every branch is straightforward and tested
 * separately.
 */
export function ToolInputForm({ schema, onSubmit, toolCallId, planText }: Props) {
  const tr = useT();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Un solo imbuto per l'invio, così la bozza si cancella in UN posto: quando la
   * risposta è partita davvero. Se l'invio fallisce la bozza resta — è
   * esattamente il momento in cui serve di più.
   */
  const submitAndForget = async (payload: Parameters<typeof onSubmit>[0]) => {
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(payload);
      clearAskDraft(toolCallId);
    } catch (err: unknown) {
      setError(errorMessage(err) || tr('ask.submitFailed'));
      setSubmitting(false);
    }
  };

  // --- Branch 1: questions (Claude SDK AskUserQuestion) ---
  if (schema.kind === 'questions') {
    return (
      <QuestionsForm
        questions={schema.questions}
        toolCallId={toolCallId}
        planText={planText}
        submitting={submitting}
        error={error}
        onSubmit={(response) => submitAndForget(response)}
      />
    );
  }

  // --- Branch 2: elicitation (MCP) ---
  // Subset JSON Schema. We support type=string|number|boolean|enum on
  // the top-level `object.properties`. Anything richer falls through to
  // the raw textarea fallback so the user can always answer.
  if (schema.kind === 'elicitation') {
    return (
      <ElicitationForm
        requestedSchema={schema.requestedSchema}
        message={schema.message}
        toolCallId={toolCallId}
        submitting={submitting}
        error={error}
        onSubmit={(value) => submitAndForget({ kind: 'elicitation', value, submittedAt: '' })}
      />
    );
  }

  // --- Branch 3: raw fallback ---
  return (
    <RawForm
      toolCallId={toolCallId}
      submitting={submitting}
      error={error}
      onSubmit={(text) => submitAndForget({ kind: 'raw', text, submittedAt: '' })}
    />
  );
}

// --- Subcomponents -------------------------------------------------------

/**
 * Il valore della scelta libera SUL FILO. Resta in inglese: è il sentinella che
 * `resolveAnswerFor` sostituisce col testo scritto, e lo stesso contratto che
 * la SDK usa. Quello che si legge a schermo è un'altra cosa — vedi
 * `OTHER_LABEL_KEY`.
 */
const OTHER = 'Other';
/** What it is called for whoever reads it: a key, so it follows the choice. */
const OTHER_LABEL_KEY = 'ask.other';

/**
 * L'opzione consigliata, e da dove si sa che lo è.
 *
 * Il campo `recommended` è la via pulita, ma il consiglio arriva anche scritto
 * nel testo — la CLI lo mette in coda al titolo come «(Recommended)», e un
 * modello che non conosce il campo fa lo stesso a parole. Riconoscere entrambe
 * le forme vuol dire che il segno si vede SUBITO, senza aspettare che tutti si
 * adeguino allo schema; e la parola in coda al titolo si toglie, o si
 * leggerebbe due volte.
 */
const RECOMMENDED_RE = /\s*[（([]?\s*(consigliat[oa]|recommended)\s*[）)\]]?\s*$/i;
function readRecommendation(opt: { label: string; description?: string; recommended?: boolean }) {
  const inLabel = RECOMMENDED_RE.test(opt.label);
  return {
    isRecommended: opt.recommended === true || inLabel || RECOMMENDED_RE.test(opt.description ?? ''),
    // Il titolo senza la parola: il chip la dice già.
    label: inLabel ? opt.label.replace(RECOMMENDED_RE, '') : opt.label,
  };
}

function QuestionsForm({
  questions, toolCallId, submitting, error, onSubmit, planText,
}: {
  questions: AskUserQuestionItem[];
  toolCallId: string;
  submitting: boolean;
  error: string | null;
  onSubmit: (response: ToolUserResponse) => Promise<void>;
  planText?: string;
}) {
  const tr = useT();
  // Selected option labels per question (keyed by question text). "Other" is a
  // sentinel entry resolved to `otherText`. A single-select question holds at
  // most one label; a `multiSelect` one holds any number — the wire format
  // stays `Record<string,string>`, so multiple picks are joined with ", ".
  // Stato iniziale dalla BOZZA salvata: un ⌘R (o l'app che riparte) non deve
  // buttare via una risposta a metà mentre l'agente è ancora fermo su quella
  // stessa domanda. Vedi askDraft.ts.
  const saved = useMemo(() => readAskDraft(toolCallId), [toolCallId]);
  const [selections, setSelections] = useState<Record<string, string[]>>(() => saved?.selections ?? {});
  const [otherText, setOtherText] = useState<Record<string, string>>(() => saved?.otherText ?? {});
  // UNA domanda alla volta, come la fa la CLI.
  //
  // Prima uscivano tutte insieme in un blocco solo: tre domande con tre righe
  // di opzioni ciascuna sono un muro, e chi legge deve tenere a mente le prime
  // due mentre risponde alla terza. A step ognuna ha la sua schermata, si può
  // tornare indietro a cambiare idea, e l'invio parte una volta sola alla fine
  // — la risposta al tool è un oggetto solo, quindi il passo non cambia niente
  // sul filo. Con una domanda sola non compare nessuna impalcatura: resta
  // esattamente il pannello di prima.
  const [step, setStep] = useState(() => saved?.step ?? 0);
  /**
   * The plan, editable in place.
   *
   * A plan gets refused over two wrong lines, and refusing throws away the
   * other forty with them. Here those two lines get fixed and approving sends
   * the corrected text (`PLAN_EDIT_KEY`). This is not an ANSWER: the decision
   * stays the two buttons, which is why a plan carries no free-text option
   * at all (see the note further down).
   */
  const planPanel = planText !== undefined && isPlanApprovalSchema({ kind: 'questions', questions });
  const [editedPlan, setEditedPlan] = useState(() => saved?.planText ?? planText ?? '');
  // Only a plan that DIFFERS is a draft. Writing it at mount would persist a
  // copy nobody touched, and on a row whose text is still the trimmed head it
  // would persist a TRUNCATED plan that approving would then send.
  const planDraft = planPanel && editedPlan !== planText ? editedPlan : undefined;
  // Si riscrive a ogni tocco: sono pochi byte in localStorage, e l'alternativa
  // (salvare "ogni tanto") perde esattamente l'ultima cosa che hai scritto.
  useEffect(() => {
    writeAskDraft(toolCallId, { selections, otherText, step, planText: planDraft });
  }, [toolCallId, selections, otherText, step, planDraft]);
  const stepped = questions.length > 1;
  const current = questions[Math.min(step, questions.length - 1)]!;
  const isLast = step >= questions.length - 1;

  const picked = (qKey: string, label: string) => (selections[qKey] || []).includes(label);

  function toggle(q: AskUserQuestionItem, label: string) {
    const qKey = q.question;
    setSelections((prev) => {
      const cur = prev[qKey] || [];
      if (q.multiSelect) {
        return { ...prev, [qKey]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [qKey]: [label] }; // single-select: replace
    });
    // Scegliere È il passo avanti: su una domanda a scelta singola, cliccare
    // l'opzione e poi cercare il tasto «Avanti» è un gesto in più che non
    // decide niente. Non vale per la scelta multipla (stai ancora scegliendo),
    // per «Altro» (stai per scrivere) né per l'ULTIMA domanda: lì il passo
    // sarebbe l'invio, e un invio per sbaglio non si annulla.
    if (!q.multiSelect && label !== OTHER && q.question === current.question && !isLast) {
      setStep((s) => Math.min(s + 1, questions.length - 1));
    }
  }

  /**
   * Il testo libero seleziona «Altro» da sé: la casella è sempre aperta, e
   * chiedere di spuntare il pallino PRIMA di poter scrivere era un passaggio a
   * vuoto. Se lo si svuota, la scelta si annulla — altrimenti resterebbe una
   * risposta vuota che il tasto d'invio accetta.
   */
  function writeOther(q: AskUserQuestionItem, text: string) {
    const qKey = q.question;
    setOtherText((prev) => ({ ...prev, [qKey]: text }));
    setSelections((prev) => {
      const cur = prev[qKey] || [];
      if (text.trim().length === 0) return { ...prev, [qKey]: cur.filter((l) => l !== OTHER) };
      if (q.multiSelect) return cur.includes(OTHER) ? prev : { ...prev, [qKey]: [...cur, OTHER] };
      return { ...prev, [qKey]: [OTHER] };
    });
  }

  const answered = (q: AskUserQuestionItem) => {
    const cur = selections[q.question] || [];
    if (cur.length === 0) return false;
    if (cur.includes(OTHER) && (otherText[q.question] || '').trim().length === 0) return false;
    return true;
  };
  const allAnswered = questions.every(answered);
  const canAdvance = answered(current);

  function resolveAnswerFor(q: AskUserQuestionItem): string {
    const cur = selections[q.question] || [];
    return cur
      .map((l) => (l === OTHER ? (otherText[q.question] || '').trim() : l))
      .filter(Boolean)
      .join(', ');
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (submitting) return;
        // Non è l'ultima: il tasto porta avanti, non invia. Un Invio dalla
        // tastiera finisce qui dentro come il click, quindi il passo si fa in
        // un posto solo.
        if (!isLast) {
          if (canAdvance) setStep((s) => Math.min(s + 1, questions.length - 1));
          return;
        }
        if (!allAnswered) return;
        const resolved: Record<string, string> = {};
        for (const q of questions) resolved[q.question] = resolveAnswerFor(q);
        // The correction rides in `metadata`, never in `answers`: the row
        // reprints every answer verbatim in its one-line recap.
        onSubmit({
          kind: 'questions',
          answers: resolved,
          ...(planDraft ? { metadata: { [PLAN_EDIT_KEY]: planDraft } } : {}),
          submittedAt: '',
        });
      }}
      className="space-y-3 bg-app-hover/30 border border-amber-500/25 rounded-md px-3 py-2.5 mt-1.5"
      data-testid={`tool-input-form-${toolCallId}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
        <HelpCircle size={12} />
        <span>{tr('tool.agentWaits')}</span>
        {stepped && (
          <span className="ml-auto normal-case tracking-normal text-app-text-muted" data-testid="ask-step-progress">
            {step + 1} di {questions.length}
          </span>
        )}
      </div>
      {/* The plan, above the two choices: read it, correct it, approve it.
          Correcting is NOT answering: the decision stays the two buttons, and
          Enter in here breaks the line instead of approving. */}
      {planPanel && (
        <div className="space-y-1">
          <label
            htmlFor={`${toolCallId}-plan-edit`}
            className="block text-[11px] uppercase tracking-wide text-app-text-muted"
          >
            {tr('plan.edit.label')}
          </label>
          <textarea
            id={`${toolCallId}-plan-edit`}
            value={editedPlan}
            onChange={(e) => setEditedPlan(e.target.value)}
            disabled={submitting}
            rows={10}
            data-testid="plan-edit-input"
            className="w-full text-[13px] leading-snug bg-surface border border-app-border rounded px-2 py-1.5 resize-y font-mono"
          />
          <div className="text-[11px] text-app-text-muted">{tr('plan.edit.hint')}</div>
        </div>
      )}
      {/* Le risposte già date, in una riga: si vede cosa hai scelto senza
          tornare indietro, e tornare indietro resta possibile col tasto sotto. */}
      {stepped && step > 0 && (
        <div className="text-[11px] text-app-text-muted space-y-0.5" data-testid="ask-step-recap">
          {questions.slice(0, step).map((q, i) => (
            <div key={`${toolCallId}-recap-${i}`} className="truncate">
              <span className="uppercase tracking-wide">{q.header || `Domanda ${i + 1}`}</span>
              <ArrowRight className="mx-1.5 inline-block w-3 h-3 align-[-2px]" aria-hidden="true" />
              <span className="text-app-text">{resolveAnswerFor(q) || '-'}</span>
            </div>
          ))}
        </div>
      )}
      {(stepped ? [current] : questions).map((q) => {
        const qIdx = questions.indexOf(q);
        const inputType = q.multiSelect ? 'checkbox' : 'radio';
        return (
        <fieldset key={`${toolCallId}-q-${qIdx}`} className="space-y-1.5">
          {/* Type scale: the question and its options are the CHAT's content —
              something to read and act on — so they sit at the message body
              size (13px, see MessageBubble), not at the 10-11px log chrome the
              surrounding tool row uses. Only the eyebrow/header/hint stay
              small, because those are labels about the content, not content. */}
          <legend className="text-[13px] leading-snug font-medium text-app-text">
            {/* Una domanda su più righe è una domanda più il suo CONTESTO: il
                permesso mette sotto al nome dello strumento gli argomenti con
                cui verrebbe eseguito. Renderizzate di fila collasserebbero in
                una riga sola, incollando il riassunto al nome. */}
            {q.question.split('\n')[0]}
            {q.header && (
              <span className="ml-2 text-[10.5px] uppercase tracking-wide text-app-text-muted">
                {q.header}
              </span>
            )}
            {q.multiSelect && (
              <span className="ml-2 text-[10.5px] normal-case tracking-normal text-app-text-muted">(scelta multipla)</span>
            )}
            {q.question.includes('\n') && (
              <div
                className="mt-1 font-mono text-[11.5px] font-normal leading-snug text-app-text-muted break-all"
                data-testid="ask-question-detail"
              >
                {q.question.slice(q.question.indexOf('\n') + 1)}
              </div>
            )}
          </legend>
          <div className="space-y-0.5">
            {(() => {
              // Il consiglio è UNO: la prima opzione marcata vince, le altre
              // tornano opzioni normali. Tre «consigliato» non consigliano.
              let already = false;
              return q.options.map((opt, oIdx) => {
                const rec = readRecommendation(opt);
                const showRec = rec.isRecommended && !already;
                if (showRec) already = true;
                return (
              <label key={`${toolCallId}-q-${qIdx}-o-${oIdx}`} className="flex items-start gap-2 text-[13px] cursor-pointer hover:bg-app-hover rounded px-1.5 py-1">
                <input
                  type={inputType}
                  name={q.multiSelect ? undefined : `${toolCallId}-q-${qIdx}`}
                  value={opt.label}
                  checked={picked(q.question, opt.label)}
                  onChange={() => toggle(q, opt.label)}
                  disabled={submitting}
                  className="mt-[3px]"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-app-text flex items-center gap-1.5 flex-wrap">
                    <span>{rec.label}</span>
                    {showRec && (
                      <span
                        data-testid="ask-recommended"
                        title={tr('ask.recommended.hint')}
                        className="text-[10px] leading-none uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/12 text-primary"
                      >
                        {tr('ask.recommended')}
                      </span>
                    )}
                  </div>
                  {/* Wraps instead of truncating: the description is often the
                      only thing that distinguishes two options. */}
                  {opt.description && (
                    <div className="text-[12px] leading-snug text-app-text-muted">{opt.description}</div>
                  )}
                </div>
              </label>
                );
              });
            })()}
            {/* «Altro» — sempre disponibile, come vuole il contratto della SDK,
                e con la casella SEMPRE APERTA: la risposta che le opzioni non
                prevedono è quella che costa di più da dare, e farla precedere
                da un pallino da spuntare è un ostacolo messo proprio lì.
                Scrivere seleziona; svuotare annulla.

                L'ECCEZIONE è la scelta su un piano. Lì dall'altra parte non c'è
                nessun modello che legga la prosa: la risposta la interpretiamo
                noi confrontandola con due etichette esatte
                (`shared/plan-decision.ts`), quindi qualunque cosa scrivessi che
                non sia «Approva ed esegui» varrebbe RIFIUTO — e il testo
                scritto sparirebbe senza che nessuno lo legga. È la stessa
                ragione per cui il composer non accetta prosa su questa domanda
                (`answerFromText`): qui la si prende premendo. */}
            {!isPlanApprovalSchema({ kind: 'questions', questions: [q] }) && (
            <label className="flex items-start gap-2 text-[13px] cursor-pointer hover:bg-app-hover rounded px-1.5 py-1">
              <input
                type={inputType}
                name={q.multiSelect ? undefined : `${toolCallId}-q-${qIdx}`}
                value={OTHER}
                checked={picked(q.question, OTHER)}
                onChange={() => toggle(q, OTHER)}
                disabled={submitting}
                className="mt-[3px]"
              />
              <div className="flex-1 min-w-0">
                <div className="text-app-text">{tr(OTHER_LABEL_KEY)}</div>
                <textarea
                  value={otherText[q.question] || ''}
                  onChange={(e) => writeOther(q, e.target.value)}
                  disabled={submitting}
                  rows={2}
                  placeholder={tr('ask.answerPlaceholder')}
                  data-testid={`ask-other-input-${qIdx}`}
                  className="mt-1 w-full text-[13px] bg-surface border border-app-border rounded px-2 py-1.5 resize-none"
                />
              </div>
            </label>
            )}
          </div>
        </fieldset>
        );
      })}
      {error && (
        <div className="text-[12px] text-red-500 bg-red-500/5 rounded px-2 py-1">{error}</div>
      )}
      <div className="flex justify-end items-center gap-2">
        {stepped && step > 0 && (
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={submitting}
            data-testid="ask-step-back"
            className="px-3 py-1.5 text-[12.5px] font-medium rounded-md text-app-text-secondary hover:bg-app-hover disabled:opacity-40 transition-colors"
          >
            {tr('ask.back')}
          </button>
        )}
        <button
          type="submit"
          disabled={(isLast ? !allAnswered : !canAdvance) || submitting}
          data-testid={isLast ? 'ask-submit' : 'ask-step-next'}
          className="flex items-center gap-1.5 px-3.5 py-1.5 text-[12.5px] font-medium rounded-md bg-primary text-white hover:bg-primary-hover disabled:bg-app-text-muted/30 disabled:text-app-text-muted disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? <Loader2 size={13} className="animate-spin" /> : isLast ? <Send size={13} /> : <ChevronRight size={13} />}
          {submitting ? tr('ask.sending') : isLast ? tr('ask.send') : tr('ask.next')}
        </button>
      </div>
    </form>
  );
}

interface ElicitationProp {
  /** Subset JSON Schema with top-level object.properties. Anything we
   *  don't recognise falls through to a JSON textarea. */
  requestedSchema: unknown;
  message?: string;
  toolCallId: string;
  submitting: boolean;
  error: string | null;
  onSubmit: (value: unknown) => Promise<void>;
}

function ElicitationForm({ requestedSchema, message, toolCallId, submitting, error, onSubmit }: ElicitationProp) {
  const tr = useT();
  const fields = useMemo(() => parseElicitationFields(requestedSchema), [requestedSchema]);
  const savedElicit = useMemo(() => readAskDraft(toolCallId), [toolCallId]);
  const [values, setValues] = useState<Record<string, unknown>>(() => savedElicit?.values ?? {});
  const [jsonText, setJsonText] = useState(() => savedElicit?.jsonText ?? '');
  useEffect(() => { writeAskDraft(toolCallId, { values, jsonText }); }, [toolCallId, values, jsonText]);

  // If we couldn't extract any fields, fall back to a raw JSON textarea —
  // the user can still answer, even if the form is less helpful.
  if (!fields) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (submitting) return;
          let parsed: unknown;
          try { parsed = jsonText ? JSON.parse(jsonText) : null; }
          catch { parsed = jsonText; /* fall back to raw string */ }
          onSubmit(parsed);
        }}
        className="space-y-2 bg-app-hover/30 border border-amber-500/25 rounded-md px-3 py-2.5 mt-1.5"
      >
        {message && <div className="text-[13px] leading-snug text-app-text">{message}</div>}
        <textarea
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          disabled={submitting}
          rows={4}
          placeholder={tr('ask.jsonPlaceholder')}
          className="w-full text-[12.5px] font-mono bg-surface border border-app-border rounded px-2 py-1.5 resize-none"
        />
        {error && <div className="text-[12px] text-red-500">{error}</div>}
        <div className="flex justify-end">
          <button type="submit" disabled={submitting} className="flex items-center gap-1.5 px-3.5 py-1.5 text-[12.5px] font-medium rounded-md bg-primary text-white hover:bg-primary-hover disabled:bg-app-text-muted/30 disabled:cursor-not-allowed">
            {submitting ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            {submitting ? tr('ask.sending') : tr('ask.send')}
          </button>
        </div>
      </form>
    );
  }

  const allRequiredFilled = fields.every((f) => {
    if (!f.required) return true;
    const v = values[f.name];
    if (f.type === 'boolean') return typeof v === 'boolean';
    return v !== undefined && v !== '' && v !== null;
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!allRequiredFilled || submitting) return;
        onSubmit(values);
      }}
      className="space-y-2 bg-app-hover/30 border border-amber-500/25 rounded-md px-3 py-2.5 mt-1.5"
      data-testid={`tool-input-form-${toolCallId}`}
    >
      {message && <div className="text-[13px] leading-snug text-app-text">{message}</div>}
      {/* `<div>` e non `<label>`: da quando il campo `enum` è il `Select`
          dell'app — un bottone che apre un menu, non un elemento di modulo — una
          `<label>` avvolgente renderebbe il nome del campo un secondo grilletto.
          Ogni controllo porta quindi il proprio nome accessibile a mano. */}
      {fields.map((f) => (
        <div key={f.name} className="block text-[13px]">
          <span className="text-app-text">
            {f.name}
            {f.required && <span className="text-red-500 ml-0.5">*</span>}
          </span>
          {f.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={values[f.name] === true}
              onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.checked }))}
              disabled={submitting}
              aria-label={f.name}
              className="ml-2"
            />
          ) : f.type === 'enum' ? (
            <div className="mt-0.5">
              <Select
                value={(values[f.name] as string) || ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
                disabled={submitting}
                ariaLabel={f.name}
                className="w-full"
                options={[
                  { value: '', label: '-' },
                  ...f.enum!.map((opt) => ({ value: opt, label: opt })),
                ]}
              />
            </div>
          ) : (
            <input
              type={f.type === 'number' ? 'number' : 'text'}
              value={(values[f.name] as string | number) ?? ''}
              onChange={(e) => {
                const raw = e.target.value;
                setValues((prev) => ({
                  ...prev,
                  [f.name]: f.type === 'number' ? (raw === '' ? '' : Number(raw)) : raw,
                }));
              }}
              disabled={submitting}
              aria-label={f.name}
              className="mt-0.5 w-full text-[13px] bg-surface border border-app-border rounded px-2 py-1.5"
            />
          )}
        </div>
      ))}
      {error && <div className="text-[12px] text-red-500">{error}</div>}
      <div className="flex justify-end">
        <button type="submit" disabled={!allRequiredFilled || submitting} className="flex items-center gap-1.5 px-3.5 py-1.5 text-[12.5px] font-medium rounded-md bg-primary text-white hover:bg-primary-hover disabled:bg-app-text-muted/30 disabled:cursor-not-allowed">
          {submitting ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          {submitting ? tr('ask.sending') : tr('ask.send')}
        </button>
      </div>
    </form>
  );
}

interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum';
  required: boolean;
  enum?: string[];
}

/**
 * Tiny subset parser for elicitation schemas. Accepts a JSON Schema that
 * looks like `{ type: 'object', properties: {...}, required: [...] }`
 * with each property being one of string/number/boolean or an enum of
 * strings. Returns null when the schema is more complex than that —
 * the caller falls back to a raw JSON textarea.
 */
function parseElicitationFields(schema: unknown): SchemaField[] | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as Record<string, unknown>;
  if (s.type !== 'object' || !s.properties || typeof s.properties !== 'object') return null;
  const props = s.properties as Record<string, unknown>;
  const required = Array.isArray(s.required) ? (s.required as string[]) : [];
  const fields: SchemaField[] = [];
  for (const [name, propRaw] of Object.entries(props)) {
    if (!propRaw || typeof propRaw !== 'object') return null;
    const prop = propRaw as Record<string, unknown>;
    if (Array.isArray(prop.enum)) {
      // Only string enums for now — anything richer is too schema-y for
      // a 200-line form runtime.
      if (prop.enum.every((e) => typeof e === 'string')) {
        fields.push({ name, type: 'enum', required: required.includes(name), enum: prop.enum as string[] });
        continue;
      }
      return null;
    }
    if (prop.type === 'string' || prop.type === 'number' || prop.type === 'boolean') {
      fields.push({ name, type: prop.type, required: required.includes(name) });
      continue;
    }
    return null;
  }
  return fields;
}

function RawForm({
  submitting, error, onSubmit, toolCallId,
}: {
  submitting: boolean;
  error: string | null;
  onSubmit: (text: string) => Promise<void>;
  toolCallId: string;
}) {
  const tr = useT();
  const [text, setText] = useState(() => readAskDraft(toolCallId)?.text ?? '');
  useEffect(() => { writeAskDraft(toolCallId, { text }); }, [toolCallId, text]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (submitting || !text.trim()) return;
        onSubmit(text);
      }}
      className="space-y-2 bg-app-hover/30 border border-amber-500/25 rounded-md px-3 py-2.5 mt-1.5"
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
        <HelpCircle size={12} />
        <span>{tr('tool.agentWaits')}</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={submitting}
        rows={3}
        placeholder={tr('ask.answerPlaceholder')}
        className="w-full text-[13px] bg-surface border border-app-border rounded px-2 py-1.5 resize-none"
      />
      {error && <div className="text-[12px] text-red-500">{error}</div>}
      <div className="flex justify-end">
        <button type="submit" disabled={submitting || !text.trim()} className="flex items-center gap-1.5 px-3.5 py-1.5 text-[12.5px] font-medium rounded-md bg-primary text-white hover:bg-primary-hover disabled:bg-app-text-muted/30 disabled:cursor-not-allowed">
          {submitting ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
          {submitting ? tr('ask.sending') : tr('ask.send')}
        </button>
      </div>
    </form>
  );
}
