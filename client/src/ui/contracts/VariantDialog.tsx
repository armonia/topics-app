import { useState } from 'react';
import { Bot, Sparkles } from 'lucide-react';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import type { Tone } from '../types';
import { Button } from '../primitives/Button';
import { Checkbox, TextArea, TextField } from '../primitives/Field';
import { Dialog } from '../primitives/Dialog';
import { TONE_TEXT } from '../tone';

type ValueMode = 'same' | 'amount' | 'share';

export interface VariantAnswers {
  reason: string;
  clauses: string[];
  /** The new value in euro, when the variation changes it. */
  value?: number;
}

/** `1.234,56` or `1234,56` or `1234.56` as a number; NaN when it is not one. */
function parseAmount(text: string): number {
  const clean = text.replace(/\s|€/g, '');
  const normal = clean.includes(',') ? clean.replace(/\./g, '').replace(',', '.') : clean;
  return normal ? Number(normal) : Number.NaN;
}

/**
 * «Nuova variante» as a short interview, the way a guided form composes a (allow-italian: quotes the Italian interface)
 * document: why, which clauses, what happens to the value (unchanged, a new
 * amount, a percentage). It shows the new value and its share of the initial
 * one as you type; the agent prepares the draft, the person decides.
 */
export function VariantDialog({ title, clauses, valueClause, currentValue, valueText, shareOf, threshold, onSubmit, onClose, copy }: {
  title: string;
  clauses: Array<{ id: string; label: string }>;
  /** The clause that carries the value: picked by itself when the value changes. */
  valueClause?: string;
  currentValue: number;
  valueText: (value: number) => string;
  /** The share of the initial value a new value means, already in words: `+4,2%`. */
  shareOf: (value: number) => string;
  /** What the share means for this contract (the 10% threshold of public contracts), if anything. */
  threshold: (value: number) => { text: string; tone: Tone } | undefined;
  onSubmit: (a: VariantAnswers) => void;
  onClose: () => void;
  copy: UiCopy;
}) {
  const t = copy.contracts.variant;
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [mode, setMode] = useState<ValueMode>('same');
  const [amount, setAmount] = useState('');
  const [share, setShare] = useState('');
  const raw = mode === 'amount' ? parseAmount(amount) : mode === 'share' ? currentValue * (1 + parseAmount(share) / 100) : currentValue;
  const value = Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) / 100 : undefined;
  const changes = mode !== 'same' && value !== undefined && value !== currentValue;
  const touched = changes && valueClause && !picked.includes(valueClause) ? [...picked, valueClause] : picked;
  const note = changes && value !== undefined ? threshold(value) : undefined;
  const missing = !reason.trim() ? t.needReason : !touched.length ? t.needClause : mode !== 'same' && !changes ? t.needValue : undefined;
  const submit = () => onSubmit({ reason: reason.trim(), clauses: touched, value: changes ? value : undefined });
  return (
    <Dialog
      title={title}
      onClose={onClose}
      closeLabel={copy.common.close}
      size="lg"
      footer={(
        <>
          {missing && <span className="mr-auto text-compact text-app-text-tertiary">{missing}</span>}
          <Button onClick={onClose}>{copy.contracts.common.cancel}</Button>
          <Button variant="primary" icon={Sparkles} onClick={missing ? false : submit} title={missing}>{t.create}</Button>
        </>
      )}
    >
      <p className="mb-4 flex items-start gap-2 rounded-lg bg-violet-500/[0.08] px-3 py-2 text-compact leading-5 text-violet-900 dark:text-violet-200">
        <Bot size={15} className="mt-0.5 shrink-0" aria-hidden="true" />{t.intro}
      </p>
      <div className="space-y-4">
        <TextArea label={t.reason} value={reason} onChange={setReason} placeholder={t.reasonPlaceholder} rows={2} hint={t.reasonHint} />
        <fieldset>
          <legend className="mb-1 text-mini font-medium text-app-text-secondary">{t.clauses}</legend>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {clauses.map((c) => (
              <Checkbox
                key={c.id}
                checked={touched.includes(c.id)}
                disabled={changes && c.id === valueClause}
                title={changes && c.id === valueClause ? t.valueClauseHint : undefined}
                onChange={(on) => setPicked((prev) => (on ? [...prev, c.id] : prev.filter((x) => x !== c.id)))}
                label={c.label}
              />
            ))}
          </div>
          <p className="mt-1 text-mini text-app-text-tertiary">{t.clausesHint}</p>
        </fieldset>
        <div>
          <div className="mb-1.5 text-mini font-medium text-app-text-secondary">{t.valueMode}</div>
          <SegmentedControl
            value={mode}
            onChange={setMode}
            ariaLabel={t.valueMode}
            options={[{ value: 'same', label: t.modes.same }, { value: 'amount', label: t.modes.amount }, { value: 'share', label: t.modes.share }]}
          />
          <div className="mt-2.5 max-w-[320px]">
            {mode === 'amount' && <TextField label={t.amount} value={amount} onChange={setAmount} placeholder={valueText(currentValue)} hint={t.amountHint} />}
            {mode === 'share' && <TextField label={t.share} value={share} onChange={setShare} placeholder="4,2" hint={t.shareHint} />}
          </div>
          <p className="mt-2 text-prose leading-5 text-app-text">
            {changes && value !== undefined ? t.preview(valueText(value), shareOf(value)) : t.unchanged(valueText(currentValue))}
          </p>
          {note && <p className={`mt-0.5 text-compact leading-5 ${TONE_TEXT[note.tone]}`}>{note.text}</p>}
        </div>
      </div>
    </Dialog>
  );
}
