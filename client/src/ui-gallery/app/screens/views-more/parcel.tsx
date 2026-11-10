/**
 * a02: the check of a case's parcel on the map. Layers switch for real, the
 * decision goes into the case (history, checklist, the step that asks for it)
 * and «not in the perimeter» asks why first. A case without a parcel says so
 * and offers the way back.
 */
import type { ReactNode } from 'react';
import { MapPinOff } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { PlaceholderScreen } from '../../../../ui/shell/PlaceholderScreen';
import { Button } from '../../../../ui/primitives/Button';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { Select, TextArea } from '../../../../ui/primitives/Field';
import { ParcelViewScreen } from '../../../../ui/views/ParcelViewScreen';
import type { MapDecisionModel } from '../../../../ui/views/model';
import { PARCEL_TEXT, parcelViewFor } from '../../../../ui/fixtures/views';
import { formatDay } from '../../../../ui/fixtures/org/clock';
import { caseSeed, findLiveCase } from '../../store/cases';
import { deckIdFor, docPath, stamp, viewName, viewsSlice } from './shared';

interface RejectDraft {
  open: boolean;
  reason: string;
  note: string;
  tried: boolean;
}

const EMPTY_REJECT: RejectDraft = { open: false, reason: '', note: '', tried: false };

const PERIMETER_ITEM = /perimetr|particell|mappa|qgis/i;

export function renderParcel(params: { record: string }, ctx: ScreenCtx): ReactNode {
  const m = ctx.copy.viewsMore;
  const id = params.record;
  const [vs, setVs] = viewsSlice(ctx);
  const [layers, setLayers] = ctx.ui<string[] | null>('parcel.layers', null);
  const [reject, setReject] = ctx.ui<RejectDraft>(`parcel.reject.${id}`, EMPTY_REJECT);
  const seed = caseSeed(id);
  const root = ctx.copy.views.root;
  if (!seed) {
    return (
      <PlaceholderScreen
        crumbs={[{ label: root }, { label: viewName('particella') }]}
        icon={MapPinOff}
        title={m.parcel.notFoundTitle(id)}
        body={m.parcel.notFoundBody}
        action={<Button variant="primary" onClick={() => ctx.go(P.views())}>{m.parcel.backToViews}</Button>}
      />
    );
  }
  const live = findLiveCase(ctx.state, id) ?? { ...seed, live: {} };
  const back = () => ctx.go(P.record(id));
  const backLabel = seed.title;
  if (!seed.parcel) {
    return (
      <PlaceholderScreen
        crumbs={[{ label: root }, { label: viewName('particella'), detail: `${seed.id} · ${seed.title}` }]}
        icon={MapPinOff}
        title={m.parcel.noParcelTitle}
        body={m.parcel.noParcelBody(seed.title)}
        leading={<Button variant="ghost" onClick={back}>{ctx.copy.common.back(backLabel)}</Button>}
        action={(
          <>
            <Button variant="primary" onClick={back}>{m.parcel.backToRecord}</Button>
            <Button onClick={() => ctx.go(P.views())}>{m.parcel.backToViews}</Button>
          </>
        )}
      />
    );
  }

  const view = parcelViewFor({ id, title: seed.title, counterpart: seed.counterpart, documents: seed.documents, parcel: seed.parcel });
  const layersOn = layers ?? view.layers.filter((l) => l.on).map((l) => l.id);
  const record = vs.decisions[`parcel:${id}`];
  const decision: MapDecisionModel | undefined = record && (record.outcome === 'in' || record.outcome === 'out')
    ? {
      text: record.outcome === 'in' ? PARCEL_TEXT.decidedIn : PARCEL_TEXT.decidedOut,
      tone: record.outcome === 'in' ? 'green' : 'amber',
      detail: `${m.parcel.by(record.who)} · ${formatDay(record.at.slice(0, 10))}${record.reason ? ` · ${record.reason}` : ''}`,
    }
    : undefined;

  const decide = (outcome: 'in' | 'out', reason?: string) => {
    const at = stamp(ctx.now);
    const who = ctx.persona.name;
    const what = outcome === 'in' ? PARCEL_TEXT.eventIn : PARCEL_TEXT.eventOut(reason ?? '');
    ctx.updateCase(id, (l) => {
      const item = seed.assistant?.checklist.find((c) => PERIMETER_ITEM.test(c.text));
      const step = seed.steps.find((s) => PERIMETER_ITEM.test(s.label) && s.state !== 'done');
      return {
        ...l,
        checklist: item ? { ...(l.checklist ?? {}), [item.id]: true } : l.checklist,
        steps: step && outcome === 'in' ? { ...(l.steps ?? {}), [step.id]: 'done' } : l.steps,
        events: [...(l.events ?? []), { at, who, what }],
      };
    }, what);
    setVs((p) => ({ ...p, decisions: { ...p.decisions, [`parcel:${id}`]: { outcome, reason, who, at } } }));
    ctx.log(`${what} (${seed.id})`, 'case', P.parcel(id));
  };

  const onConfirm = ctx.allow('edit:data', () => {
    decide('in');
    ctx.toast({ tone: 'ok', title: m.parcel.toastIn, body: m.parcel.toastInBody, action: { label: m.parcel.backToRecord, path: P.record(id) } });
    ctx.go(P.record(id));
  });
  const onReject = ctx.allow('edit:data', () => setReject({ ...EMPTY_REJECT, open: true }));
  const onReopen = ctx.allow('edit:data', () => {
    setVs((p) => {
      const next = { ...p.decisions };
      delete next[`parcel:${id}`];
      return { ...p, decisions: next };
    });
    ctx.updateCase(id, (l) => ({ ...l, events: [...(l.events ?? []), { at: stamp(ctx.now), who: ctx.persona.name, what: m.parcel.eventReopened }] }), m.parcel.eventReopened);
    ctx.toast({ tone: 'info', title: m.parcel.toastReopened });
  });
  const submitReject = () => {
    const reason = [reject.reason, reject.note.trim()].filter(Boolean).join(': ');
    if (!reject.reason || !reject.note.trim()) {
      setReject((r) => ({ ...r, tried: true }));
      return;
    }
    decide('out', reason);
    setReject(EMPTY_REJECT);
    ctx.toast({ tone: 'warn', title: m.parcel.toastOut, body: m.parcel.toastOutBody });
  };

  const detail = seed.id;
  const shown = {
    ...view,
    crumbs: [{ label: root }, { label: viewName('particella'), detail }],
  };

  return (
    <>
      <ParcelViewScreen
        view={shown}
        copy={ctx.copy}
        onBack={back}
        backLabel={backLabel}
        onConfirm={onConfirm}
        onReject={onReject}
        onPresentation={() => ctx.go(P.presentation(deckIdFor(id)))}
        layersOn={layersOn}
        onToggleLayer={(lid) => setLayers(layersOn.includes(lid) ? layersOn.filter((x) => x !== lid) : [...layersOn, lid])}
        onOpenSource={(s) => ctx.go(docPath(id, s.id ?? ''))}
        onOpenOriginal={(oid) => ctx.go(docPath(id, oid))}
        decision={decision}
        onReopen={onReopen}
        confirmTitle={ctx.deniedTitle('edit:data')}
        phone={ctx.phone}
      />
      {reject.open && (
        <Dialog
          title={m.parcel.rejectTitle}
          size="sm"
          closeLabel={ctx.copy.common.close}
          onClose={() => setReject(EMPTY_REJECT)}
          footer={(
            <>
              <Button onClick={() => setReject(EMPTY_REJECT)}>{m.parcel.cancel}</Button>
              <Button variant="danger" onClick={submitReject}>{m.parcel.rejectSubmit}</Button>
            </>
          )}
        >
          <div className="flex flex-col gap-3">
            <p>{m.parcel.rejectBody(live.title)}</p>
            <Select
              label={m.parcel.reasonLabel}
              value={reject.reason}
              onChange={(reason) => setReject((r) => ({ ...r, reason }))}
              options={[{ value: '', label: m.parcel.reasonPick }, ...PARCEL_TEXT.reasons.map((r) => ({ value: r, label: r }))]}
            />
            <TextArea
              label={m.parcel.noteLabel}
              value={reject.note}
              onChange={(note) => setReject((r) => ({ ...r, note }))}
              placeholder={m.parcel.notePlaceholder}
              rows={3}
              hint={reject.tried && (!reject.reason || !reject.note.trim()) ? m.parcel.rejectNeeds : m.parcel.noteHint}
            />
          </div>
        </Dialog>
      )}
    </>
  );
}
