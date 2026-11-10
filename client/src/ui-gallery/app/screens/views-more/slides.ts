/**
 * Builds the slides of a presentation from a case: the problem, the parcel on
 * the map, the norms it cites, the earlier cases, the deadlines, the
 * documents and what is asked. A slide with nothing to say is not made (no
 * parcel, no map slide), so the count of slides and sources is always honest.
 */
import type { UiCopy } from '../../../../ui/copy/types';
import type { SlideBullet, SlideModel } from '../../../../ui/views/model';
import { formatDay } from '../../../../ui/fixtures/org/clock';
import type { CaseSeed } from '../../../../ui/fixtures/org/types';
import { CASES } from '../../../../ui/fixtures/org/cases';
import { normLabel, parcelViewFor } from '../../../../ui/fixtures/views';
import type { LiveCase } from '../../store/cases';

/** `verifica-2418` and `2418` both name case 2418. (allow-italian: quotes the Italian interface) */
export const deckCaseId = (deckId: string): string => deckId.replace(/^verifica-/, ''); // allow-italian: an address, shown as written

const sourceOf = (seed: CaseSeed, docId: string | undefined) => {
  const doc = seed.documents.find((d) => d.id === docId) ?? seed.documents[0];
  return doc ? { label: doc.name, id: doc.id } : undefined;
};

export function buildSlides(seed: LiveCase, copy: UiCopy): SlideModel[] {
  const d = copy.viewsMore.deck.slideNames;
  const slides: SlideModel[] = [];
  slides.push({ id: 'cover', name: d.cover, kind: 'cover', title: seed.title, subtitle: seed.subject });

  const asks = seed.fields.filter((f) => f.id !== 'ufficio' && f.id !== 'titolario' && f.id !== 'fascicolo').slice(0, 4);
  slides.push({
    id: 'ask', name: d.ask, kind: 'bullets', title: d.askTitle,
    bullets: asks.map((f): SlideBullet => ({ text: `${f.label}: ${f.value}`, source: sourceOf(seed, f.source.doc) })),
  });

  if (seed.parcel) {
    const view = parcelViewFor({ id: seed.id, title: seed.title, counterpart: seed.counterpart, documents: seed.documents, parcel: seed.parcel });
    slides.push({
      id: 'map', name: d.map, kind: 'map', title: d.mapTitle,
      map: view.map,
      bullets: view.panel.checks.slice(0, 3).map((c): SlideBullet => ({ text: `${c.label}: ${c.value}`, source: sourceOf(seed, view.panel.originals[1]?.id) })),
    });
  }

  if (seed.norms?.length) {
    slides.push({
      id: 'norms', name: d.norms, kind: 'bullets', title: d.normsTitle,
      bullets: seed.norms.map((n): SlideBullet => ({ text: normLabel(n), source: { label: normLabel(n.split('/')[0]), id: n } })),
    });
  }

  const related = (seed.related ?? []).map((id) => CASES.find((c) => c.id === id)).filter((c): c is CaseSeed => Boolean(c));
  if (related.length) {
    slides.push({
      id: 'related', name: d.related, kind: 'bullets', title: d.relatedTitle,
      bullets: related.map((c): SlideBullet => ({ text: `${c.id} · ${c.title}`, source: { label: c.id, id: c.id } })),
    });
  }

  if (seed.deadlines.length) {
    slides.push({
      id: 'deadlines', name: d.deadlines, kind: 'facts', title: d.deadlinesTitle,
      facts: seed.deadlines.map((dl) => ({ label: `${dl.label} · ${dl.rule}`, value: formatDay(dl.date) })),
    });
  }

  const docs = seed.documents.filter((x) => !x.draft);
  slides.push({
    id: 'documents', name: d.documents, kind: 'bullets', title: d.documentsTitle,
    bullets: docs.map((x): SlideBullet => ({ text: `${x.name} · ${x.detail}`, source: { label: x.name, id: x.id } })),
  });

  slides.push({
    id: 'request', name: d.request, kind: 'bullets', title: d.requestTitle,
    bullets: [{ text: seed.proposal }, { text: seed.primaryAction.label }],
  });
  return slides;
}

/** How many sources the included slides cite: the number the panel prints. */
export const countSources = (slides: SlideModel[]): number =>
  slides.reduce((n, s) => n + (s.bullets ?? []).filter((b) => b.source).length, 0);
