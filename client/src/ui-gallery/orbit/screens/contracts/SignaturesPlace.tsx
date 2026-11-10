/**
 * Signatures and approvals of a contract (`/conoscenza/contratti/:id/firme`): the chain (allow-italian: address segment)
 * of the version under approval, step by step, with the controls of the step
 * it waits on (approve, sign, countersign, ask for changes) for whoever may
 * act on it; who may do what on this contract, by role; and the log of what
 * was done. The agent prepares, a person approves and signs.
 */
import clsx from 'clsx';
import { CircleCheck, FileSignature, Lock, PenLine, Send, ShieldCheck, Undo2 } from 'lucide-react';
import type { ApprovalStep, Contract } from '../../../../ui/fixtures/orbit-org/types';
import type { Permission } from '../../../../ui/fixtures/org/people';
import type { Tone } from '../../../../ui/types';
import { accessSlice, type AccessLevel } from '../../../app/store/access-grants';
import { personaById, teamIdOfPerson, teamMembers, world } from '../../world';
import { Button } from '../../../../ui/primitives/Button';
import { Card } from '../../../../ui/primitives/Card';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { TextArea, TextField } from '../../../../ui/primitives/Field';
import { ProgressBar } from '../../../../ui/primitives/Progress';
import { Timeline, type TimelineItemModel } from '../../../../ui/primitives/Timeline';
import { ApprovalChain, PermissionTable } from '../../../../ui/contracts/Signatures';
import type { PermissionRowModel } from '../../../../ui/contracts/model';
import type { ScreenCtx } from '../../../app/kit';
import { handValue, teamOfPersona, teamValue, type AccessRow } from '../../model/access';
import { contractsSlice, liveContractById } from '../../model/live';
import { actionLabel, latestVersion } from '../../model/contracts';
import { SP } from '../../paths';
import { READING_COLUMN } from '../../../../ui/shell/layout';
import { approveStep, countersignStep, requestChanges, signStep, type SignatureReceipt } from './actions';
import { ContractFrame, NotFound } from './frame';
import { approvalModels } from './view';
import { actorOf, currentStep, isDirection, isReadOnly, stamp, teamLabelOf, underApproval } from './model';

/** The permission a step asks of who acts on it. */
function needOf(action: ApprovalStep['action']): Permission {
  if (action === 'firma') return 'sign:contracts'; // allow-italian: data code compared by value
  if (action === 'rivede' || action === 'approva') return 'approve:contracts'; // allow-italian: data codes compared by value
  return 'edit:contracts';
}

function StepControls({ ctx, c, step }: { ctx: ScreenCtx; c: Contract; step: ApprovalStep }) {
  const t = ctx.copy.contracts.signatures;
  const [note, setNote] = ctx.ui<string>(`contracts.note.${c.id}`, '');
  const [asking, setAsking] = ctx.ui<boolean>(`contracts.asking.${c.id}`, false);
  const [, setReceipt] = ctx.ui<SignatureReceipt | null>('contracts.receipt', null);
  const job = ctx.job(`sign:${c.id}`) ?? ctx.job(`countersign:${c.id}`);
  const need = needOf(step.action);
  const mine = ctx.persona.id === step.who || isDirection(ctx.persona.id);
  const denied = !ctx.can(need)
    ? isReadOnly(ctx.persona.id) ? ctx.copy.contracts.common.readOnly(teamLabelOf(ctx.persona.id)) : need === 'sign:contracts' ? t.denied.sign : need === 'approve:contracts' ? t.denied.approve : t.denied.edit
    : !mine ? t.denied.notYou(personaById(step.who)?.name ?? step.who) : undefined;
  if (job?.status === 'running') return <ProgressBar value={job.progress} label={job.title} detail={job.current ?? t.actions.running} />;
  const main = step.action === 'firma'
    ? { label: t.actions.sign, icon: FileSignature, run: () => signStep(ctx, c, step, setReceipt) }
    : step.action === 'controfirma' // allow-italian: data code compared by value
      ? { label: t.actions.countersign, icon: Send, run: () => countersignStep(ctx, c, step, setReceipt) }
      : step.action === 'redige' // allow-italian: data code compared by value
        ? { label: t.actions.draft, icon: PenLine, run: () => { approveStep(ctx, c, step, note.trim()); setNote(''); } }
        : { label: t.actions.approve, icon: CircleCheck, run: () => { approveStep(ctx, c, step, note.trim()); setNote(''); } };
  const canAsk = step.action !== 'redige' && step.action !== 'controfirma'; // allow-italian: data codes compared by value
  const withNote = step.action === 'rivede' || step.action === 'approva' || step.action === 'redige'; // allow-italian: data codes compared by value
  const signing = step.action === 'firma'; // allow-italian: data code compared by value
  return (
    <div className="space-y-2">
      {!asking && withNote && (
        <TextField label={t.actions.note} value={note} onChange={setNote} placeholder={t.actions.notePlaceholder} disabled={Boolean(denied)} title={denied} />
      )}
      {asking && <TextArea label={t.actions.requestChanges} value={note} onChange={setNote} placeholder={t.actions.changesPlaceholder} rows={2} hint={note.trim() ? undefined : t.denied.needNote} />}
      <div className="flex flex-wrap items-center gap-2">
        {asking ? (
          <>
            <Button variant="ghost" onClick={() => { setAsking(false); setNote(''); }}>{ctx.copy.contracts.common.cancel}</Button>
            <Button icon={Undo2} onClick={note.trim() && !denied ? () => { requestChanges(ctx, c, step, note.trim()); setAsking(false); setNote(''); } : false} title={denied ?? (note.trim() ? undefined : t.denied.needNote)}>{t.actions.sendBack}</Button>
          </>
        ) : (
          <>
            <Button variant={signing ? 'primary' : 'confirm'} icon={main.icon} onClick={denied ? false : main.run} title={denied}>{main.label}</Button>
            {canAsk && <Button icon={Undo2} onClick={denied ? false : () => setAsking(true)} title={denied}>{t.actions.requestChanges}</Button>}
          </>
        )}
      </div>
    </div>
  );
}

/** The levels as the permissions page names them, and the tone each one wears. */
const LEVEL_TONE: Record<AccessLevel, Tone> = { none: 'neutral', view: 'neutral', work: 'blue', manage: 'green' };

/**
 * One row per team, from the same source as «Squadra › Permessi»: the team's
 * level on Contratti and the two actions on contracts (`teamValue`, with what
 * an admin set there), plus the people who were given another level.
 */
function matrixRows(ctx: ScreenCtx, c: Contract): PermissionRowModel[] {
  const t = ctx.copy.contracts.signatures;
  const levels = ctx.copy.orbitTeam.levels;
  const slice = accessSlice(ctx.state);
  const mine = teamOfPersona(ctx.persona);
  const section: AccessRow = { kind: 'section', id: 'contracts' };
  return world().people.teams.map((team): PermissionRowModel => {
    const level = teamValue(ctx.state, team.id, section) as AccessLevel;
    const people = teamMembers(team.id);
    const allowed = (id: 'approve:contracts' | 'sign:contracts') => teamValue(ctx.state, team.id, { kind: 'action', id }) === true;
    const can = [allowed('approve:contracts') ? t.matrix.approve : '', allowed('sign:contracts') ? t.matrix.sign : ''].filter(Boolean);
    const exceptions = people.flatMap((p) => {
      const lines: string[] = [];
      const own = handValue(slice, { person: p.id }, section) as AccessLevel | undefined;
      if (own && own !== level) lines.push(`${p.name}, ${levels[own].label}`);
      for (const [id, text] of [['approve:contracts', t.matrix.approve], ['sign:contracts', t.matrix.sign]] as const) {
        const hand = handValue(slice, { person: p.id }, { kind: 'action', id }) as boolean | undefined;
        if (hand !== undefined && hand !== allowed(id)) lines.push(`${p.name}, ${hand ? text : t.matrix.without(text)}`);
      }
      return lines;
    });
    const steps = c.approvals.filter((s) => teamIdOfPerson(s.who) === team.id).map((s) => actionLabel[s.action]);
    return {
      id: team.id,
      team: team.label,
      people: people.map((p) => actorOf(p.id)),
      level: levels[level].label,
      levelTone: LEVEL_TONE[level],
      can,
      exceptions,
      inChain: steps.length ? [...new Set(steps)].join(', ') : undefined,
      you: mine === team.id,
    };
  });
}

function auditItems(ctx: ScreenCtx, c: Contract): TimelineItemModel[] {
  const t = ctx.copy.contracts.signatures;
  const slice = contractsSlice(ctx.state);
  const items: Array<TimelineItemModel & { sort: string }> = [];
  for (const s of c.approvals) {
    if (s.state !== 'fatto' || !s.at) continue; // allow-italian: data code compared by value
    items.push({ id: `step:${s.id}`, sort: s.at, at: stamp(s.at), title: t.audit.step(actionLabel[s.action], actorOf(s.who).name), detail: s.note, tone: s.action === 'firma' || s.action === 'controfirma' ? 'green' : 'blue', icon: s.action === 'firma' || s.action === 'controfirma' ? FileSignature : CircleCheck }); // allow-italian: data codes compared by value
  }
  for (const [key, r] of Object.entries(slice.changes ?? {})) {
    if (!key.startsWith(`${c.id}:`)) continue;
    items.push({ id: `changes:${key}`, sort: r.at, at: stamp(r.at), title: t.audit.request(personaById(r.by)?.name ?? r.by), detail: r.note, tone: 'amber', icon: Undo2 });
  }
  for (const [key, r] of Object.entries(slice.receipts ?? {})) {
    if (!key.startsWith(`${c.id}:v`)) continue;
    const v = Number(key.slice(c.id.length + 2));
    items.push({ id: `receipt:${key}`, sort: r.at, at: stamp(r.at), title: t.audit.signed(v, r.register), detail: r.hash, tone: 'green', icon: FileSignature, onOpen: () => ctx.go(SP.attachment(c.id, `signed-v${v}`)) });
  }
  return items.sort((a, b) => b.sort.localeCompare(a.sort)).map(({ sort: _sort, ...rest }) => rest);
}

export function SignaturesPlace({ ctx, id }: { ctx: ScreenCtx; id: string }) {
  const c = liveContractById(ctx.state, id);
  if (!c) return <NotFound ctx={ctx} />;
  const t = ctx.copy.contracts.signatures;
  const step = currentStep(c.approvals);
  const [receipt, setReceipt] = ctx.ui<SignatureReceipt | null>('contracts.receipt', null);
  const m = t.matrix;
  const audit = auditItems(ctx, c);
  return (
    <ContractFrame ctx={ctx} c={c} page="signatures" crumb={t.crumb}>
      <div className="grid gap-4 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className={clsx(READING_COLUMN, 'min-w-0 space-y-3')}>
          <h2 className="text-body-lg font-semibold text-app-text">{t.chainTitle(latestVersion(c).n)}</h2>
          {underApproval(c) && (
            <p className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/[0.06] px-3 py-2 text-compact leading-5 text-sky-900 dark:text-sky-200">
              <Lock size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{t.locked}
            </p>
          )}
          <ApprovalChain steps={approvalModels(ctx, c)} ariaLabel={t.chainTitle(latestVersion(c).n)} currentActions={step && <StepControls ctx={ctx} c={c} step={step} />} />
        </div>
        <Card title={t.auditTitle} icon={FileSignature} className="self-start">
          {audit.length ? <Timeline items={audit} ariaLabel={t.auditTitle} /> : <p>{t.auditEmpty}</p>}
        </Card>
      </div>
      <section className="px-4 pb-6">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
          <div className="min-w-0">
            <h2 className="text-body-lg font-semibold text-app-text">{t.matrixTitle}</h2>
            <p className="text-compact text-app-text-tertiary">{t.matrixHint}</p>
          </div>
          <Button icon={ShieldCheck} onClick={() => ctx.go(SP.teamPermissions())}>{m.openPermissions}</Button>
        </div>
        <PermissionTable rows={matrixRows(ctx, c)} copy={ctx.copy} />
      </section>
      {receipt && (
        <Dialog
          title={receipt.title}
          onClose={() => setReceipt(null)}
          closeLabel={ctx.copy.common.close}
          footer={(
            <>
              {receipt.path && <Button onClick={() => { const path = receipt.path as string; setReceipt(null); ctx.go(path); }}>{t.receipt.openCopy}</Button>}
              <Button variant="primary" onClick={() => setReceipt(null)}>{ctx.copy.common.close}</Button>
            </>
          )}
        >
          <p className="mb-3 flex items-center gap-2 text-prose font-medium text-emerald-700 dark:text-emerald-400"><CircleCheck size={16} aria-hidden="true" />{receipt.at}</p>
          <ul className="space-y-1.5 break-all rounded-lg border border-app-border bg-app-inset px-3.5 py-3 font-mono text-compact leading-5 text-app-text">
            {receipt.lines.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </Dialog>
      )}
    </ContractFrame>
  );
}
