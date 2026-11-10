import { useState } from 'react';
import { Eye, FilePlus2, Lightbulb, Pencil, ShieldCheck, ThumbsUp } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { Dialog } from '../primitives/Dialog';
import { Select, TextArea, TextField } from '../primitives/Field';
import { KeyValue } from '../primitives/Panel';
import type { MatrixRoleModel, MatrixRowModel, OptionModel, ProposalModel, RightsRowModel, YouRowModel } from './model';
import { PermissionMatrix, RightsTable } from './PermissionMatrix';
import { SectionHead } from './parts';

export interface ProposalDraft {
  title: string;
  reason: string;
  flow: string;
}

/** The window that asks for a change: what and why. */
function ProposalDialog({ copy, flows, onSubmit, onClose }: {
  copy: UiCopy;
  flows: OptionModel[];
  onSubmit: (draft: ProposalDraft) => void;
  onClose: () => void;
}) {
  const p = copy.team.structure.proposals;
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');
  const [flow, setFlow] = useState('');
  const [tried, setTried] = useState(false);
  const submit = () => {
    setTried(true);
    if (!title.trim()) return;
    onSubmit({ title: title.trim(), reason: reason.trim(), flow });
  };
  return (
    <Dialog
      title={p.dialogTitle}
      onClose={onClose}
      closeLabel={copy.team.common.close}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{copy.team.common.cancel}</Button>
          <Button variant="primary" icon={FilePlus2} onClick={submit}>{p.dialogSubmit}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField label={p.dialogTitleField} value={title} onChange={setTitle} error={tried && !title.trim() ? p.titleRequired : undefined} autoFocus onEnter={submit} />
        <TextArea label={p.dialogReason} value={reason} onChange={setReason} rows={3} />
        <Select label={p.dialogFlow} value={flow} onChange={setFlow} options={[{ value: '', label: p.noFlow }, ...flows]} />
      </div>
    </Dialog>
  );
}

/** Who may change which part of the structure, role by role, with the proposals waiting. */
export function StructurePage({ copy, roles, rows, onToggle, disabledTitle, rights, proposals, you, flows, onPropose, canPropose, proposeTitle, phone }: {
  copy: UiCopy;
  roles: MatrixRoleModel[];
  rows: MatrixRowModel[];
  onToggle: (roleId: string, rowId: string, next: boolean) => void;
  disabledTitle?: string;
  rights: RightsRowModel[];
  proposals: ProposalModel[];
  you: { role: string; rows: YouRowModel[] };
  flows: OptionModel[];
  onPropose: (draft: ProposalDraft) => void;
  canPropose: boolean;
  proposeTitle?: string;
  phone?: boolean;
}) {
  const s = copy.team.structure;
  const [dialog, setDialog] = useState(false);
  const LEVEL: Record<YouRowModel['level'], { tone: 'green' | 'blue' | 'neutral'; text: string }> = {
    edit: { tone: 'green', text: s.you.canEdit },
    propose: { tone: 'blue', text: s.you.canPropose },
    see: { tone: 'neutral', text: s.you.canSee },
    none: { tone: 'neutral', text: s.you.cannotSee },
  };
  return (
    <div className="flex flex-col gap-6">
      <p className="text-prose leading-6 text-app-text-secondary">{s.intro}</p>

      <section>
        <SectionHead title={s.rolesTitle} aside={s.rolesBody} />
        <PermissionMatrix
          ariaLabel={s.rolesLabel}
          permissionColumn={s.permissionColumn}
          roles={roles}
          rows={rows}
          onToggle={onToggle}
          toggleTitle={(role, row) => `${role}: ${row}`}
          disabledTitle={disabledTitle}
          changedTitle={s.toggles.changed}
        />
      </section>

      <section>
        <SectionHead title={s.partsTitle} aside={s.partsBody} />
        <RightsTable rows={rights} copy={copy} />
      </section>

      <div className="grid gap-3 md:grid-cols-3">
        <Card title={s.explain.seeTitle} icon={Eye}><p className="px-3.5 pb-3 pt-2 text-prose leading-5 text-app-text-secondary">{s.explain.seeBody}</p></Card>
        <Card title={s.explain.proposeTitle} icon={Lightbulb}><p className="px-3.5 pb-3 pt-2 text-prose leading-5 text-app-text-secondary">{s.explain.proposeBody}</p></Card>
        <Card title={s.explain.approveTitle} icon={ThumbsUp}><p className="px-3.5 pb-3 pt-2 text-prose leading-5 text-app-text-secondary">{s.explain.approveBody}</p></Card>
      </div>

      <div className={phone ? 'flex flex-col gap-4' : 'grid grid-cols-[1.2fr_1fr] items-start gap-4'}>
        <Card
          title={s.proposals.title}
          icon={Pencil}
          actions={<Button size="sm" icon={FilePlus2} onClick={canPropose ? () => setDialog(true) : false} title={proposeTitle}>{s.proposals.add}</Button>}
        >
          <div className="flex flex-col gap-4 px-3.5 pb-3.5 pt-3">
            {proposals.length === 0 && <p className="text-prose text-app-text-tertiary">{s.proposals.empty}</p>}
            {proposals.map((p) => (
              <article key={p.id} className="flex flex-col gap-2 border-b border-app-border pb-4 last:border-b-0 last:pb-0">
                <Chip>{s.proposals.tag}</Chip>
                <h4 className="text-body-lg font-semibold text-app-text">{p.title}</h4>
                {p.reason && <p className="text-prose leading-5 text-app-text-secondary">«{p.reason}»</p>}
                <p className="text-mini text-app-text-tertiary">{p.asked}</p>
                <ol className="flex flex-wrap gap-1.5" aria-label={s.proposals.whoDoes}>
                  {p.stageLabels.map((label, i) => (
                    <li key={label} aria-current={i === p.stage ? 'step' : undefined}>
                      <Chip tone={i < p.stage ? 'green' : i === p.stage ? 'blue' : 'neutral'} strong={i === p.stage}>{label}</Chip>
                    </li>
                  ))}
                </ol>
                <div>
                  <KeyValue label={s.proposals.edits} value={p.edits} />
                  <KeyValue label={s.proposals.tests} value={s.proposals.testsValue} />
                  <KeyValue label={s.proposals.approves} value={p.approves} />
                </div>
                <div><Button variant="primary" onClick={p.onOpen}>{s.proposals.open}</Button></div>
              </article>
            ))}
          </div>
        </Card>
        <Card title={s.you.title(you.role)} icon={ShieldCheck}>
          <div className="flex flex-col px-3.5 pb-3 pt-1.5">
            {you.rows.map((r) => (
              <KeyValue key={r.id} label={r.name} value={<Chip tone={LEVEL[r.level].tone}>{LEVEL[r.level].text}</Chip>} />
            ))}
          </div>
        </Card>
      </div>

      {dialog && (
        <ProposalDialog
          copy={copy}
          flows={flows}
          onClose={() => setDialog(false)}
          onSubmit={(d) => {
            onPropose(d);
            setDialog(false);
          }}
        />
      )}
    </div>
  );
}
