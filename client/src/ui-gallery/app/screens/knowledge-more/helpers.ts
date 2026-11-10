/* Pure helpers of the knowledge screens: no JSX, shared by the places. */
import type { ScreenCtx } from '../../kit';
import type { CollectionModel, UsageGroupModel } from '../../../../ui/knowledge/model';
import { COLLECTIONS, PROCEDURES, STAFF_COUNTS, findArticle, type ItemSeed } from '../../../../ui/fixtures/knowledge-more';
import { SUGGESTIONS } from '../../../../ui/fixtures/knowledge-more-answers';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { P } from '../../paths';
import {
  allItems, answerItems, answerQuestion, articleShort, citingCases, citingFlows, citingProcedures, liveProcedure, procedureStatus,
} from './engine';
import type { DocsState, ProceduresState } from './state';

/** The count of procedures that wait for a person to review them. */
export function reviewing(procs: ProceduresState) {
  return PROCEDURES.filter((p) => ['da-rivedere', 'modifiche'].includes(procedureStatus(p, liveProcedure(procs, p.id)))); // allow-italian: status key, never shown
}

/** The path a collection item opens: a procedure has its own page. */
export function openItemPath(id: string): string {
  return PROCEDURES.some((p) => p.id === id) ? P.procedure(id) : P.knowledgeDoc(id);
}

/** The collections for the tree on the left, with the items the person can open. */
export function treeCollections(ctx: ScreenCtx, docs: DocsState, expanded: (id: string) => boolean): CollectionModel[] {
  return COLLECTIONS.map((col) => {
    const locked = !!col.roles && !col.roles.includes(ctx.persona.role);
    let items: Array<{ id: string; label: string }> = [];
    if (col.id === 'procedure') items = PROCEDURES.map((p) => ({ id: p.id, label: p.title }));
    else if (col.id === 'personale') items = locked ? [] : [{ id: 'staff', label: STAFF_COUNTS.map((s) => s.label).join(', ') }];
    else items = allItems(docs).filter((i) => i.collection === col.id).map((i) => ({ id: i.id, label: i.label }));
    return { id: col.id, label: col.label, locked, expanded: expanded(col.id), items };
  });
}

/** Who cites an item or one article of it, by kind, as the «used by» tab and the panel print it. */
export function usageGroups(ctx: ScreenCtx, item: ItemSeed, docs: DocsState, procs: ProceduresState, article?: ReturnType<typeof findArticle>): UsageGroupModel[] {
  const k = ctx.copy.knowledgeMore.doc;
  const pr = ctx.copy.knowledgeMore.procedure;
  /* A case that cites several articles of the item is one row, not one per article. */
  const cases = citingCases(item.id, article ? item : undefined, article)
    .filter(({ seed }, i, all) => all.findIndex((x) => x.seed.id === seed.id) === i)
    .map(({ seed, article: a }) => {
      const cited = findArticle(item, a);
      return { id: seed.id, title: `${seed.id} · ${seed.title}`, detail: k.caseDetail(OFFICE_LABEL[seed.office], cited ? articleShort(cited) : item.label) };
    });
  const procedures = citingProcedures(item.id, article, article ? item : undefined).map((p) => ({
    id: p.id,
    title: p.title,
    detail: k.procedureDetail(pr.statuses[procedureStatus(p, liveProcedure(procs, p.id))]),
  }));
  const flows = citingFlows(item).map((f) => ({ id: `${f.flowId}/${f.stepId}`, title: f.flowName, detail: k.flowDetail(f.stepLabel, f.detail) }));
  const answers = SUGGESTIONS.filter((q) => answerItems(answerQuestion(q, docs, procs)).has(item.id)).map((q) => ({ id: q, title: q, detail: k.answerDetail }));
  const asked = docs.questions
    .filter((x) => !SUGGESTIONS.includes(x.q) && answerItems(answerQuestion(x.q, docs, procs)).has(item.id))
    .map((x) => ({ id: x.q, title: x.q, detail: k.answerDetail }));
  return [
    { id: 'cases', label: k.usageCases, rows: cases },
    { id: 'procedures', label: k.usageProcedures, rows: procedures },
    { id: 'flows', label: k.usageFlows, rows: flows },
    { id: 'answers', label: k.usageAnswers, rows: [...answers, ...asked] },
  ];
}

export function openUsage(ctx: ScreenCtx, groupId: string, rowId: string) {
  if (groupId === 'cases') ctx.go(P.record(rowId));
  else if (groupId === 'procedures') ctx.go(P.procedure(rowId));
  else if (groupId === 'flows') {
    const [flow, step] = rowId.split('/');
    ctx.go(step ? P.flowStep(flow, step) : P.flow(flow));
  } else if (groupId === 'answers') ctx.go(P.knowledgeSearch(rowId));
}
