/**
 * One record with everything together (w05): values with their sources,
 * deadlines with their calculation and rule, linked records, steps, the whole
 * history and the documents. Reached from the record's «Dati» section, from a
 * receipt and from the day's deadlines.
 */
import { FileText, User } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import { Button } from '../../../../ui/primitives/Button';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { MenuButton } from '../../../../ui/primitives/Menu';
import { RecordSheet } from '../../../../ui/work/RecordSheet';
import { PERSONAS } from '../../../../ui/fixtures/org/people';
import { normLabel, protocolProgram } from '../../../../ui/fixtures/work';
import { findLiveCase, visibleCases } from '../../store/cases';
import { P } from '../../paths';
import { receiptsOf, recordPathOf } from './adapters';
import { assignCase, startPrimary } from './actions';
import { openOriginal } from './keys';
import { assigneeItems } from './assignees';
import { sheetOf } from './sheet';

/** The program page a place name of the sheet opens. */
const PROGRAM_PAGE: Record<string, string> = {
  Halley: 'halley',
  Prunes: 'prunes',
  TeamSystem: 'teamsystem',
  QGIS: 'qgis',
  'SharePoint Legale': 'm365',
};

export function SheetPlace({ ctx, id }: { ctx: ScreenCtx; id: string }) {
  const w = ctx.copy.work.record;
  const c = visibleCases(ctx.state, ctx.persona).find((x) => x.id === id) ?? findLiveCase(ctx.state, id);
  if (!c) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EmptyState icon={FileText} title={w.notFoundTitle} action={<Button onClick={() => ctx.go(P.inbox())}>{w.backToList}</Button>}>{w.notFoundBody}</EmptyState>
      </div>
    );
  }
  const sheet = sheetOf(c, ctx.state, ctx.copy);
  const edit = (fn: () => void) => ctx.allow('edit:data', fn);
  const denied = ctx.deniedTitle('edit:data');
  const receipts = receiptsOf(c);
  const assignee = PERSONAS.find((p) => p.id === c.assignee);
  const program = protocolProgram(c.kind);

  /* A deadline opens the norm it cites; without one in the knowledge base, the list of all deadlines. */
  const normOf = (rule: string) => (c.norms ?? []).find((n) => {
    const [item, art] = normLabel(n).split(', ');
    return rule.includes(item) && (!art || rule.includes(art.replace(/ c\.\d+$/, '')));
  });

  return (
    <RecordSheet
      sheet={sheet}
      copy={ctx.copy}
      phone={ctx.phone}
      onBackToRecord={() => ctx.go(recordPathOf(c))}
      onAsk={() => {
        ctx.dispatch({ type: 'ui', key: `work.record.${c.id}.tab`, update: () => 'assistant' });
        ctx.go(recordPathOf(c));
      }}
      onOpenProgram={() => ctx.go(P.program(PROGRAM_PAGE[program] ?? 'halley'))}
      primaryVariant={receipts.length > 0 ? 'secondary' : 'confirm'}
      primaryTitle={receipts.length > 0 ? undefined : denied}
      onPrimary={receipts.length > 0 ? () => ctx.go(recordPathOf(c)) : edit(() => startPrimary(ctx, c))}
      assignee={(
        <MenuButton
          size="sm"
          variant="ghost"
          label={assignee?.name ?? c.assignee}
          icon={User}
          align="right"
          items={assigneeItems(ctx, c.org, c.assignee)}
          onSelect={(pid) => { const run = edit(() => assignCase(ctx, c, pid)); if (run) run(); }}
          disabled={!ctx.can('edit:data')}
          title={denied}
        />
      )}
      onOpenStep={(step) => ctx.go(P.flowStep(c.flow, step))}
      onOpenFact={(fid) => {
        if (fid === 'term') ctx.go(c.fields.some((f) => f.id === 'scadenza') ? P.recordOrigin(c.id, 'scadenza') : P.deadlines());
        else if (fid === 'protocol') ctx.go(P.inbox(c.id));
      }}
      onOpenField={(fid) => ctx.go(P.recordOrigin(c.id, fid))}
      onOpenDeadline={(did) => {
        const d = c.deadlines.find((x) => x.id === did);
        const n = d ? normOf(d.rule) : undefined;
        if (n) {
          const [item, article] = n.split('/');
          ctx.go(P.knowledgeDoc(item, article));
        } else ctx.go(P.deadlines());
      }}
      onOpenHistory={(hid) => {
        const e = c.history[Number(hid.slice(2))];
        if (e?.doc) openOriginal(ctx, c, e.doc);
      }}
      onOpenDocument={(did) => openOriginal(ctx, c, did)}
      onOpenRelated={(rid) => ctx.go(recordPathOf({ id: rid, org: c.org }))}
      onOpenSystem={(sid) => {
        const row = sheet.systems.find((x) => x.id === sid);
        const page = row ? PROGRAM_PAGE[row.where] : undefined;
        ctx.go(page ? P.program(page) : row?.where === 'Topics' ? recordPathOf(c) : P.programs());
      }}
    />
  );
}
