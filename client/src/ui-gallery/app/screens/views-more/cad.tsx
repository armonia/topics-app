/**
 * a03: the CAD sheet of a concession checked against the regulation. The
 * layers switch, the measure tool measures between two clicked points on the
 * sheet, notes pin where the reader clicks, and «conforme» or «chiedi
 * integrazione» close the check: the second one sends a PEC (simulated, with
 * a receipt) and both leave a line in the case.
 */
import type { ReactNode } from 'react';
import { FileX2 } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { PlaceholderScreen } from '../../../../ui/shell/PlaceholderScreen';
import { Button } from '../../../../ui/primitives/Button';
import { CadViewScreen } from '../../../../ui/views/CadViewScreen';
import type { CadTool } from '../../../../ui/views/CadSheet';
import type { CadMeasureModel, CadNoteModel, CadPoint, MapDecisionModel } from '../../../../ui/views/model';
import {
  CAD_DRAFT, CAD_ORIGINALS, CAD_SHEET, cadRulesOf, formatMeters, metersBetween,
} from '../../../../ui/fixtures/views';
import { formatDay } from '../../../../ui/fixtures/org/clock';
import { caseSeed } from '../../store/cases';
import { deckIdFor, docPath, stamp, viewName, viewsSlice } from './shared';

export function renderCad(params: { record: string }, ctx: ScreenCtx): ReactNode {
  const m = ctx.copy.viewsMore;
  const c = m.cad;
  const id = params.record;
  const [vs, setVs] = viewsSlice(ctx);
  const [hidden, setHidden] = ctx.ui<string[]>('cad.hidden', []);
  const [tool, setTool] = ctx.ui<CadTool>('cad.tool', 'view');
  const [measures, setMeasures] = ctx.ui<CadMeasureModel[]>(`cad.measures.${id}`, []);
  const [pending, setPending] = ctx.ui<CadPoint | null>(`cad.pending.${id}`, null);
  const [notes, setNotes] = ctx.ui<CadNoteModel[]>(`cad.notes.${id}`, []);
  const seed = caseSeed(id);
  const root = ctx.copy.views.root;
  const name = viewName('tavola');
  if (!seed || (seed.kind !== 'concessione' && seed.kind !== 'verbale')) {
    return (
      <PlaceholderScreen
        crumbs={[{ label: root }, { label: name, detail: seed ? `${seed.id} · ${seed.title}` : id }]}
        icon={FileX2}
        title={seed ? c.noSheetTitle : c.notFoundTitle(id)}
        body={seed ? c.noSheetBody(seed.title) : c.notFoundBody}
        action={(
          <>
            {seed && <Button variant="primary" onClick={() => ctx.go(P.record(id))}>{m.parcel.backToRecord}</Button>}
            <Button variant={seed ? 'secondary' : 'primary'} onClick={() => ctx.go(P.views())}>{m.parcel.backToViews}</Button>
          </>
        )}
      />
    );
  }
  const rules = cadRulesOf(CAD_SHEET);
  const record = vs.decisions[`cad:${id}`];
  const decision: MapDecisionModel | undefined = record && (record.outcome === 'conform' || record.outcome === 'request')
    ? {
      text: record.outcome === 'conform' ? c.decidedConform : c.decidedRequest,
      tone: record.outcome === 'conform' ? 'green' : 'amber',
      detail: `${m.parcel.by(record.who)} · ${formatDay(record.at.slice(0, 10))}`,
    }
    : undefined;

  const onPoint = (p: CadPoint) => {
    if (tool === 'measure') {
      if (!pending) {
        setPending(p);
        return;
      }
      const label = formatMeters(metersBetween(CAD_SHEET, pending, p));
      setMeasures((list) => [...list, { id: `m${list.length + 1}-${Math.round(p[0])}-${Math.round(p[1])}`, a: pending, b: p, label }]);
      setPending(null);
    } else if (tool === 'note') {
      setNotes((list) => [...list, { id: `n${list.length + 1}-${Math.round(p[0])}-${Math.round(p[1])}`, at: p, text: c.noteDefault(list.length + 1) }]);
      setTool('view');
    }
  };

  const recordDecision = (outcome: 'conform' | 'request', what: string) => {
    const at = stamp(ctx.now);
    const who = ctx.persona.name;
    ctx.updateCase(id, (l) => ({ ...l, events: [...(l.events ?? []), { at, who, what }] }), what);
    setVs((p) => ({ ...p, decisions: { ...p.decisions, [`cad:${id}`]: { outcome, who, at } } }));
    ctx.log(`${what} (${seed.id})`, 'case', P.cad(id));
  };

  const failing = rules.filter((r) => !r.ok);
  const conform = () => {
    recordDecision('conform', c.eventConform);
    ctx.toast({ tone: 'ok', title: c.toastConform, action: { label: m.parcel.backToRecord, path: P.record(id) } });
  };
  const onConform = ctx.allow('edit:data', () => {
    if (!failing.length) {
      conform();
      return;
    }
    ctx.confirm({
      title: c.confirmConformTitle,
      body: c.confirmConformBody(failing.map((r) => r.label).join(', ')),
      confirmLabel: c.confirmConformAction,
      onConfirm: conform,
    });
  });
  const onRequest = ctx.allow('edit:data', () => {
    const jobId = `cad-request-${id}`;
    ctx.startJob({
      id: jobId,
      title: c.jobTitle,
      steps: [
        { label: c.jobPrepare, ms: 700 },
        { label: c.jobSign, ms: 800 },
        { label: c.jobSend, ms: 900 },
      ],
      onDone: (ok) => {
        if (!ok) {
          ctx.toast({ tone: 'error', title: c.toastRequestFailed });
          return;
        }
        const at = stamp(ctx.now);
        ctx.updateCase(id, (l) => ({
          ...l,
          receipts: [...(l.receipts ?? []), { at, title: c.receiptTitle, lines: [c.receiptAccepted(at), c.receiptDelivered(at), c.receiptFailing(failing.map((r) => r.label).join(', ') || '-')] }],
        }));
        recordDecision('request', c.eventRequest);
        ctx.toast({ tone: 'ok', title: c.toastRequest, body: c.toastRequestBody, action: { label: m.parcel.backToRecord, path: P.record(id) } });
      },
    });
  });
  const onReopen = ctx.allow('edit:data', () => {
    setVs((p) => {
      const next = { ...p.decisions };
      delete next[`cad:${id}`];
      return { ...p, decisions: next };
    });
    ctx.toast({ tone: 'info', title: m.parcel.toastReopened });
  });
  const onUseDraft = ctx.allow('edit:data', () => {
    ctx.updateCase(id, (l) => ({ ...l, draftAdded: [...(l.draftAdded ?? []), CAD_DRAFT] }), c.eventDraft);
    setVs((p) => ({ ...p, cadDraft: { ...p.cadDraft, [id]: true } }));
    ctx.toast({ tone: 'ok', title: c.toastDraft, action: { label: m.parcel.backToRecord, path: P.record(id) } });
  });
  const job = ctx.job(`cad-request-${id}`);

  return (
    <>
      <CadViewScreen
        copy={ctx.copy}
        crumbs={[{ label: root }, { label: name, detail: seed.id }]}
        sheet={CAD_SHEET}
        rules={rules}
        hiddenLayers={hidden}
        onToggleLayer={(lid) => setHidden(hidden.includes(lid) ? hidden.filter((x) => x !== lid) : [...hidden, lid])}
        tool={tool}
        onTool={(t) => {
          setTool(t);
          setPending(null);
        }}
        measures={measures}
        pending={pending ?? undefined}
        onPoint={onPoint}
        onDeleteMeasure={(mid) => setMeasures((list) => list.filter((x) => x.id !== mid))}
        onClearMeasures={() => setMeasures([])}
        notes={notes}
        onNoteText={(nid, text) => setNotes((list) => list.map((n) => (n.id === nid ? { ...n, text } : n)))}
        onDeleteNote={(nid) => setNotes((list) => list.filter((n) => n.id !== nid))}
        originals={CAD_ORIGINALS}
        onOpenOriginal={(oid) => ctx.go(docPath(id, oid))}
        draft={CAD_DRAFT}
        onUseDraft={onUseDraft}
        draftUsed={Boolean(vs.cadDraft[id])}
        decision={decision}
        onReopen={onReopen}
        onConform={onConform}
        onRequest={onRequest}
        onPresentation={() => ctx.go(P.presentation(deckIdFor(id)))}
        onBack={() => ctx.go(P.record(id))}
        backLabel={seed.title}
        deniedTitle={ctx.deniedTitle('edit:data')}
        phone={ctx.phone}
        scale={c.scale}
      />
      {job?.status === 'running' && (
        <div role="status" className="pointer-events-none fixed bottom-4 left-1/2 z-[9000] -translate-x-1/2 rounded-lg border border-app-border bg-surface px-3 py-2 text-compact text-app-text shadow-lg">
          {job.current ?? c.jobTitle} · {Math.round(job.progress * 100)}%
        </div>
      )}
    </>
  );
}
