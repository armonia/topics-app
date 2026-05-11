import { useMemo, useState } from 'react';
import { HelpCircle, Send, Loader2 } from 'lucide-react';
import type { ToolUserResponse, UserInputSchema, AskUserQuestionItem } from '../../types';

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
export function ToolInputForm({ schema, onSubmit, toolCallId }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Branch 1: questions (Claude SDK AskUserQuestion) ---
  if (schema.kind === 'questions') {
    return (
      <QuestionsForm
        questions={schema.questions}
        toolCallId={toolCallId}
        submitting={submitting}
        error={error}
        onSubmit={async (response) => {
          setError(null);
          setSubmitting(true);
          try {
            await onSubmit(response);
          } catch (err: any) {
            setError(err?.message || 'Submission failed');
            setSubmitting(false);
          }
        }}
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
        onSubmit={async (value) => {
          setError(null);
          setSubmitting(true);
          try {
            await onSubmit({ kind: 'elicitation', value, submittedAt: '' });
          } catch (err: any) {
            setError(err?.message || 'Submission failed');
            setSubmitting(false);
          }
        }}
      />
    );
  }

  // --- Branch 3: raw fallback ---
  return (
    <RawForm
      submitting={submitting}
      error={error}
      onSubmit={async (text) => {
        setError(null);
        setSubmitting(true);
        try {
          await onSubmit({ kind: 'raw', text, submittedAt: '' });
        } catch (err: any) {
          setError(err?.message || 'Submission failed');
          setSubmitting(false);
        }
      }}
    />
  );
}

// --- Subcomponents -------------------------------------------------------

function QuestionsForm({
  questions, toolCallId, submitting, error, onSubmit,
}: {
  questions: AskUserQuestionItem[];
  toolCallId: string;
  submitting: boolean;
  error: string | null;
  onSubmit: (response: ToolUserResponse) => Promise<void>;
}) {
  // `answers` keyed by question text — same shape the server persists
  // and re-injects into the provider stream.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // Per-question free-text override when the user picks "Other".
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  const allAnswered = questions.every((q) => {
    const a = answers[q.question];
    if (!a) return false;
    if (a === 'Other') return (otherText[q.question] || '').trim().length > 0;
    return true;
  });

  function resolveAnswerFor(q: AskUserQuestionItem): string {
    const selection = answers[q.question];
    if (selection === 'Other') return otherText[q.question] || '';
    return selection || '';
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!allAnswered || submitting) return;
        const resolved: Record<string, string> = {};
        for (const q of questions) resolved[q.question] = resolveAnswerFor(q);
        onSubmit({ kind: 'questions', answers: resolved, submittedAt: '' });
      }}
      className="space-y-3 bg-app-hover/30 rounded-md px-3 py-2.5 mt-1.5"
      data-testid={`tool-input-form-${toolCallId}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
        <HelpCircle size={12} />
        <span>L'agente attende la tua risposta</span>
      </div>
      {questions.map((q, qIdx) => (
        <fieldset key={`${toolCallId}-q-${qIdx}`} className="space-y-1">
          <legend className="text-[11px] font-medium text-app-text">
            {q.question}
            {q.header && (
              <span className="ml-2 text-[10px] uppercase tracking-wide text-app-text-muted">
                {q.header}
              </span>
            )}
          </legend>
          <div className="space-y-0.5 pl-1">
            {q.options.map((opt, oIdx) => (
              <label key={`${toolCallId}-q-${qIdx}-o-${oIdx}`} className="flex items-start gap-2 text-[11px] cursor-pointer hover:bg-app-hover rounded px-1 py-0.5">
                <input
                  type="radio"
                  name={`${toolCallId}-q-${qIdx}`}
                  value={opt.label}
                  checked={answers[q.question] === opt.label}
                  onChange={() => setAnswers((prev) => ({ ...prev, [q.question]: opt.label }))}
                  disabled={submitting}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-app-text">{opt.label}</div>
                  {opt.description && (
                    <div className="text-[10px] text-app-text-muted truncate">{opt.description}</div>
                  )}
                </div>
              </label>
            ))}
            {/* "Other" — always available; mirrors the SDK contract. */}
            <label className="flex items-start gap-2 text-[11px] cursor-pointer hover:bg-app-hover rounded px-1 py-0.5">
              <input
                type="radio"
                name={`${toolCallId}-q-${qIdx}`}
                value="Other"
                checked={answers[q.question] === 'Other'}
                onChange={() => setAnswers((prev) => ({ ...prev, [q.question]: 'Other' }))}
                disabled={submitting}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="text-app-text">Other</div>
                {answers[q.question] === 'Other' && (
                  <textarea
                    value={otherText[q.question] || ''}
                    onChange={(e) => setOtherText((prev) => ({ ...prev, [q.question]: e.target.value }))}
                    disabled={submitting}
                    rows={2}
                    placeholder="Type your answer…"
                    className="mt-1 w-full text-[11px] bg-surface border border-app-border rounded px-2 py-1 resize-none"
                  />
                )}
              </div>
            </label>
          </div>
        </fieldset>
      ))}
      {error && (
        <div className="text-[11px] text-red-500 bg-red-500/5 rounded px-2 py-1">{error}</div>
      )}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!allAnswered || submitting}
          className="flex items-center gap-1.5 px-3 py-1 text-[11px] rounded-md bg-primary text-white hover:bg-primary-hover disabled:bg-app-text-muted/30 disabled:text-app-text-muted disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
          {submitting ? 'Sending…' : 'Send'}
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
  const fields = useMemo(() => parseElicitationFields(requestedSchema), [requestedSchema]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [jsonText, setJsonText] = useState('');

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
        className="space-y-2 bg-app-hover/30 rounded-md px-3 py-2.5 mt-1.5"
      >
        {message && <div className="text-[11px] text-app-text-muted">{message}</div>}
        <textarea
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          disabled={submitting}
          rows={4}
          placeholder="JSON value (or plain text)…"
          className="w-full text-[11px] font-mono bg-surface border border-app-border rounded px-2 py-1.5 resize-none"
        />
        {error && <div className="text-[11px] text-red-500">{error}</div>}
        <div className="flex justify-end">
          <button type="submit" disabled={submitting} className="flex items-center gap-1.5 px-3 py-1 text-[11px] rounded-md bg-primary text-white hover:bg-primary-hover disabled:bg-app-text-muted/30 disabled:cursor-not-allowed">
            {submitting ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
            {submitting ? 'Sending…' : 'Send'}
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
      className="space-y-2 bg-app-hover/30 rounded-md px-3 py-2.5 mt-1.5"
      data-testid={`tool-input-form-${toolCallId}`}
    >
      {message && <div className="text-[11px] text-app-text-muted">{message}</div>}
      {fields.map((f) => (
        <label key={f.name} className="block text-[11px]">
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
              className="ml-2"
            />
          ) : f.type === 'enum' ? (
            <select
              value={(values[f.name] as string) || ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
              disabled={submitting}
              className="mt-0.5 w-full text-[11px] bg-surface border border-app-border rounded px-2 py-1"
            >
              <option value="">—</option>
              {f.enum!.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
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
              className="mt-0.5 w-full text-[11px] bg-surface border border-app-border rounded px-2 py-1"
            />
          )}
        </label>
      ))}
      {error && <div className="text-[11px] text-red-500">{error}</div>}
      <div className="flex justify-end">
        <button type="submit" disabled={!allRequiredFilled || submitting} className="flex items-center gap-1.5 px-3 py-1 text-[11px] rounded-md bg-primary text-white hover:bg-primary-hover disabled:bg-app-text-muted/30 disabled:cursor-not-allowed">
          {submitting ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
          {submitting ? 'Sending…' : 'Send'}
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
  submitting, error, onSubmit,
}: {
  submitting: boolean;
  error: string | null;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (submitting || !text.trim()) return;
        onSubmit(text);
      }}
      className="space-y-2 bg-app-hover/30 rounded-md px-3 py-2.5 mt-1.5"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
        <HelpCircle size={12} />
        <span>L'agente attende la tua risposta</span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={submitting}
        rows={3}
        placeholder="Your answer…"
        className="w-full text-[11px] bg-surface border border-app-border rounded px-2 py-1.5 resize-none"
      />
      {error && <div className="text-[11px] text-red-500">{error}</div>}
      <div className="flex justify-end">
        <button type="submit" disabled={submitting || !text.trim()} className="flex items-center gap-1.5 px-3 py-1 text-[11px] rounded-md bg-primary text-white hover:bg-primary-hover disabled:bg-app-text-muted/30 disabled:cursor-not-allowed">
          {submitting ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
          {submitting ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
