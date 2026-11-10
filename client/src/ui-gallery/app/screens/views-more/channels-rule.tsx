/**
 * ch01: the dialog that adds a routing rule to a channel (when a message says
 * this, do that, optionally start a flow). Its own file so the channels screen
 * module exports only its renderer.
 */
import type { ScreenCtx } from '../../kit';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { Select, TextField } from '../../../../ui/primitives/Field';
import { Button } from '../../../../ui/primitives/Button';

export interface RuleDraft { open: boolean; when: string; then: string; flow: string; tried: boolean }

export function RuleDialog({ copy, draft, onDraft, flows, onClose, onSubmit }: {
  copy: ScreenCtx['copy'];
  draft: RuleDraft;
  onDraft: (p: Partial<RuleDraft>) => void;
  flows: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const c = copy.viewsMore.channels;
  return (
    <Dialog
      title={c.addRule}
      size="sm"
      closeLabel={copy.common.close}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{c.cancel}</Button>
          <Button variant="primary" onClick={onSubmit}>{c.saveRule}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3">
        <TextField label={c.ruleWhenLabel} value={draft.when} onChange={(when) => onDraft({ when })} placeholder={c.ruleWhenPlaceholder} error={draft.tried && !draft.when.trim() ? c.ruleNeeds : undefined} autoFocus />
        <TextField label={c.ruleThenLabel} value={draft.then} onChange={(then) => onDraft({ then })} placeholder={c.ruleThenPlaceholder} error={draft.tried && !draft.then.trim() ? c.ruleNeeds : undefined} />
        <Select label={c.ruleFlowLabel} value={draft.flow} onChange={(flow) => onDraft({ flow })} options={[{ value: '', label: c.ruleNoFlow }, ...flows.map((f) => ({ value: f.id, label: f.name }))]} />
      </div>
    </Dialog>
  );
}
