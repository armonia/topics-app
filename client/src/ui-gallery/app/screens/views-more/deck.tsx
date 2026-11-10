/**
 * a04: the presentation made from a case. The slides come from the case's own
 * data, the reader picks which to keep, steps through them full-pane, makes a
 * share link (a visible job, then a link they can copy or revoke, each one a
 * line in the log) and prepares the PDF.
 */
import type { ReactNode } from 'react';
import { Presentation } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { PlaceholderScreen } from '../../../../ui/shell/PlaceholderScreen';
import { Button } from '../../../../ui/primitives/Button';
import { PresentationScreen, type DeckMode } from '../../../../ui/views/PresentationScreen';
import { DECK_DEFAULTS } from '../../../../ui/fixtures/views';
import { formatDay } from '../../../../ui/fixtures/org/clock';
import { ORGS } from '../../../../ui/fixtures/org/people';
import { findLiveCase } from '../../store/cases';
import { buildSlides, countSources, deckCaseId } from './slides';
import { docPath, hashText, stamp, viewsSlice } from './shared';

interface ShareForm {
  to: string;
  expires: string;
  code: boolean;
  anonymize: boolean;
  style: string;
  branding: boolean;
}

const FORM_INITIAL: ShareForm = { to: DECK_DEFAULTS.to, expires: DECK_DEFAULTS.expires, code: true, anonymize: true, style: 'institutional', branding: true };

export function renderDeck(params: { id: string }, ctx: ScreenCtx): ReactNode {
  const m = ctx.copy.viewsMore;
  const d = m.deck;
  const deckId = params.id;
  const [vs, setVs] = viewsSlice(ctx);
  const [mode, setMode] = ctx.ui<DeckMode>('deck.mode', 'slides');
  const [current, setCurrent] = ctx.ui(`deck.slide.${deckId}`, 0);
  const [included, setIncluded] = ctx.ui<Record<string, boolean>>(`deck.included.${deckId}`, {});
  const [presenting, setPresenting] = ctx.ui('deck.presenting', false);
  const [form, setForm] = ctx.ui<ShareForm>(`deck.form.${deckId}`, FORM_INITIAL);
  const caseId = deckCaseId(deckId);
  const seed = findLiveCase(ctx.state, caseId);
  const root = ctx.copy.views.root;
  if (!seed) {
    return (
      <PlaceholderScreen
        crumbs={[{ label: root }, { label: d.crumb('') }]}
        icon={Presentation}
        title={d.notFoundTitle(caseId)}
        body={d.notFoundBody}
        action={<Button variant="primary" onClick={() => ctx.go(P.views())}>{m.parcel.backToViews}</Button>}
      />
    );
  }
  const set = (patch: Partial<ShareForm>) => setForm({ ...form, ...patch });
  const slides = buildSlides(seed, ctx.copy);
  const shown = slides.filter((s) => included[s.id] !== false);
  const org = ORGS.find((o) => o.id === seed.org);
  const day = ctx.now.slice(0, 10);
  const links = vs.shares.filter((s) => s.deck === deckId);
  const pdf = seed.documents.find((x) => x.pdf);
  const shareJob = ctx.job(`share-${deckId}`);
  const exportJob = ctx.job(`export-${deckId}`);
  const exported = vs.exported[deckId];

  const openSource = (src: { label: string; id?: string }) => {
    const sid = src.id ?? '';
    if (sid.includes('/')) {
      const [item, article] = sid.split('/');
      ctx.go(P.knowledgeDoc(item, article));
    } else if (seed.documents.some((x) => x.id === sid)) ctx.go(P.recordDoc(caseId, sid));
    else if (sid && /^[\w-]+$/.test(sid) && findLiveCase(ctx.state, sid)) ctx.go(P.record(sid));
    else ctx.go(docPath(caseId, sid));
  };

  const onShare = ctx.allow('export', () => {
    if (!form.to.trim()) {
      ctx.toast({ tone: 'warn', title: d.toastNoRecipient });
      return;
    }
    if (!shown.length) {
      ctx.toast({ tone: 'warn', title: d.noSlides });
      return;
    }
    const to = form.to.trim();
    ctx.startJob({
      id: `share-${deckId}`,
      title: d.jobShare,
      steps: [
        { label: form.anonymize ? d.jobAnonymize : d.jobCheck, ms: 800 },
        { label: d.jobSign, ms: 700 },
        { label: d.jobLink, ms: 500 },
      ],
      onDone: (ok) => {
        if (!ok) {
          ctx.toast({ tone: 'error', title: d.toastShareFailed });
          return;
        }
        const token = hashText(`${deckId}${to}${ctx.now}${vs.shares.length}`).toString(36);
        const url = `https://condividi.topics.example/p/${token}`;
        setVs((p) => ({ ...p, shares: [{ id: `sh-${token}`, deck: deckId, to, url, expires: form.expires, at: stamp(ctx.now), code: form.code }, ...p.shares] }));
        ctx.log(d.logShared(seed.title, to), 'share', P.presentation(deckId));
        ctx.toast({ tone: 'ok', title: d.toastShared, body: d.toastSharedBody(to, formatDay(form.expires)) });
      },
    });
  });

  const onExport = ctx.allow('export', () => {
    ctx.startJob({
      id: `export-${deckId}`,
      title: d.jobExport,
      steps: [{ label: d.jobRender, ms: 900 }, { label: d.jobPdf, ms: 700 }],
      onDone: (ok) => {
        if (!ok) {
          ctx.toast({ tone: 'error', title: d.toastExportFailed });
          return;
        }
        setVs((p) => ({ ...p, exported: { ...p.exported, [deckId]: day } }));
        ctx.log(d.logExported(seed.title), 'share', P.presentation(deckId));
        ctx.toast({ tone: 'ok', title: d.toastExported, body: pdf ? d.toastExportedBody : d.toastExportedNoFile });
      },
    });
  });

  const job = shareJob?.status === 'running' ? shareJob : exportJob?.status === 'running' ? exportJob : undefined;

  return (
    <PresentationScreen
      copy={ctx.copy}
      // The example marker stays in the field; the header title would be cut with it.
      crumbs={[{ label: d.crumb(form.to.replace(/\s*\(esempio\)\s*$/, '').trim()) }]}
      slides={slides}
      included={included}
      onToggleSlide={(sid) => setIncluded({ ...included, [sid]: included[sid] === false })}
      current={current}
      onSelect={setCurrent}
      mode={mode}
      onMode={setMode}
      orgLabel={org?.name ?? ''}
      orgMonogram={org?.monogram ?? ''}
      footer={d.footer(formatDay(day))}
      stats={{ slides: shown.length, sources: countSources(shown) }}
      share={{
        to: form.to, onTo: (to) => set({ to }),
        expires: form.expires, onExpires: (expires) => set({ expires }),
        code: form.code, onCode: (code) => set({ code }),
        anonymize: form.anonymize, onAnonymize: (anonymize) => set({ anonymize }),
        style: form.style, onStyle: (style) => set({ style }),
        styles: [{ value: 'institutional', label: d.styles.institutional }, { value: 'brief', label: d.styles.brief }, { value: 'technical', label: d.styles.technical }],
        branding: form.branding, onBranding: (branding) => set({ branding }),
      }}
      links={links.map((l) => ({
        id: l.id, to: l.to, url: l.url, expires: formatDay(l.expires), at: formatDay(l.at.slice(0, 10)), code: l.code,
        onCopy: () => {
          void navigator.clipboard?.writeText(l.url).catch(() => undefined);
          ctx.toast({ tone: 'ok', title: d.toastCopied, body: l.url });
        },
        onRevoke: () => ctx.confirm({
          title: d.confirmRevokeTitle(l.to),
          body: d.confirmRevokeBody,
          confirmLabel: d.revoke,
          tone: 'danger',
          onConfirm: () => {
            setVs((p) => ({ ...p, shares: p.shares.filter((x) => x.id !== l.id) }));
            ctx.log(d.logRevoked(seed.title, l.to), 'share', P.presentation(deckId));
            ctx.toast({ tone: 'info', title: d.toastRevoked });
          },
        }),
      }))}
      onShare={onShare}
      onExport={onExport}
      exportDone={exported && pdf?.pdf ? { label: d.download(pdf.name), onDownload: () => {
        window.open(pdf.pdf, '_blank', 'noopener');
        ctx.toast({ tone: 'info', title: d.toastDownload(pdf.name) });
      } } : undefined}
      job={job ? { title: job.title, progress: job.progress, detail: job.current ?? '' } : undefined}
      presenting={presenting}
      onPresent={() => {
        setCurrent(0);
        setPresenting(true);
      }}
      onExitPresent={() => setPresenting(false)}
      onOpenSource={openSource}
      onBack={() => ctx.go(P.record(caseId))}
      backLabel={seed.title}
      status={d.generated(formatDay(day))}
      phone={ctx.phone}
      deniedTitle={ctx.deniedTitle('export')}
      generatedAt={formatDay(day)}
    />
  );
}
