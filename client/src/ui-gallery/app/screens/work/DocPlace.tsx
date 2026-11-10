/**
 * An original next to its summary (v01): the page images and the PDF of one
 * document of a case, the AI summary with each sentence tied to its page, the
 * values read from it, and the quote of a value when the reader comes from
 * «where does this come from».
 */
import type { ScreenCtx } from '../../kit';
import { DocumentScreen, type DocumentMode } from '../../../../ui/work/DocumentScreen';
import { DocSummary } from '../../../../ui/work/DocSummary';
import { SECTOR_WORK, recordName } from '../../../../ui/fixtures/work';
import { findLiveCase, visibleCases } from '../../store/cases';
import { P } from '../../paths';
import { docFieldsOf, pointsOf, recordPathOf } from './adapters';
import { MODE_KEY, focusKey, openOriginal, pageKey, zoomKey, type DocFocus } from './keys';

export function DocPlace({ ctx, id, doc: docId }: { ctx: ScreenCtx; id: string; doc: string }) {
  const [mode, setMode] = ctx.ui<DocumentMode>(MODE_KEY, 'side');
  const [pageRaw, setPage] = ctx.ui<number>(pageKey(id, docId), 1);
  const [zoom, setZoom] = ctx.ui<number>(zoomKey(id, docId), 1);
  const [focus] = ctx.ui<DocFocus | null>(focusKey(id), null);

  const c = visibleCases(ctx.state, ctx.persona).find((x) => x.id === id) ?? findLiveCase(ctx.state, id);
  const doc = c?.documents.find((d) => d.id === docId);
  if (!c || !doc) {
    return (
      <DocumentScreen
        model={undefined}
        copy={ctx.copy}
        mode={mode}
        onMode={setMode}
        page={1}
        onPage={setPage}
        zoom={1}
        onZoom={setZoom}
        onBack={() => ctx.go(c ? recordPathOf(c) : P.inbox())}
        onSelectDoc={() => undefined}
        phone={ctx.phone}
      />
    );
  }

  const page = Math.min(Math.max(1, pageRaw), Math.max(1, doc.pages.length));
  const field = focus && focus.doc === docId ? c.fields.find((f) => f.id === focus.field) : undefined;
  const quote = field ? { text: `… ${field.source.before}${field.source.highlight}${field.source.after} …`, page: field.source.page } : undefined;
  const points = pointsOf(doc);
  const summary = (
    <DocSummary
      points={points}
      fields={docFieldsOf(c, doc, ctx.copy)}
      page={page}
      copy={ctx.copy}
      wide={mode === 'summary'}
      onOpenPoint={(pid) => {
        const p = doc.summary[Number(pid)];
        if (p) setPage(p.page);
        if (mode === 'summary') setMode('side');
      }}
      onOpenField={(fid) => {
        const f = c.fields.find((x) => x.id === fid);
        if (!f) return;
        openOriginal(ctx, c, f.source.doc, f.source.page, f.id);
        if (mode === 'summary') setMode('side');
      }}
    />
  );
  return (
    <DocumentScreen
      model={{
        crumbs: [{ label: SECTOR_WORK.myRecords }, { label: c.id }, { label: doc.name }],
        backLabel: recordName(c.id),
        docs: c.documents.map((d) => ({ id: d.id, name: d.name })),
        activeId: doc.id,
        name: doc.name,
        detail: doc.detail,
        pages: doc.pages,
        pdf: doc.pdf,
        signedNote: doc.signed ? ctx.copy.work.doc.signedValid(doc.from) : undefined,
        exampleTag: SECTOR_WORK.exampleTag,
        quote,
      }}
      copy={ctx.copy}
      mode={mode}
      onMode={setMode}
      page={page}
      onPage={setPage}
      zoom={zoom}
      onZoom={setZoom}
      summary={summary}
      onBack={() => ctx.go(recordPathOf(c))}
      onSelectDoc={(d) => openOriginal(ctx, c, d)}
      onDownload={() => ctx.toast({ tone: 'ok', title: ctx.copy.work.toast.downloaded(doc.name) })}
      phone={ctx.phone}
    />
  );
}
