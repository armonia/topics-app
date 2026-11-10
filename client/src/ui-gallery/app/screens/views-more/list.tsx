/**
 * a01: the saved views and the catalogue of blocks. The reader filters and
 * searches the views, adds the sector's and the standard ones to the
 * organization, makes a new one from the blocks (or from a description in
 * words), duplicates and removes, and opens where each one opens.
 */
import type { ReactNode } from 'react';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { ViewsListScreen, type ViewScopeKey } from '../../../../ui/views/ViewsListScreen';
import { CreateViewDialog } from '../../../../ui/views/CreateViewDialog';
import type { BlockId, ViewCardModel } from '../../../../ui/views/model';
import {
  BLOCK_EXISTS, BLOCK_IDS, BLOCK_READS, BLOCK_TONE, BLOCK_WORDS, KIND_LABEL,
} from '../../../../ui/fixtures/views';
import type { CaseKind } from '../../../../ui/fixtures/org/types';
import {
  activeSteps, entryOf, hashText, openPath, viewEntries, viewsSlice, type CustomView, type ViewEntry,
} from './shared';

interface CreateDraft {
  open: boolean;
  name: string;
  description: string;
  blocks: BlockId[];
  kind: string;
  tried: boolean;
}

const EMPTY_DRAFT: CreateDraft = { open: false, name: '', description: '', blocks: [], kind: '', tried: false };

/** The kinds a view can be made for, offered in the dialog: the ones the sector's views already name. */
const KINDS: CaseKind[] = ['ricorso', 'sgravio', 'concessione', 'verbale', 'accesso', 'segnalazione', 'fattura', 'irrigazione', 'regione'];

const slug = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);

export function renderViewsList(ctx: ScreenCtx): ReactNode {
  const v = ctx.copy.viewsMore;
  const [vs, setVs] = viewsSlice(ctx);
  const [scope, setScope] = ctx.ui<ViewScopeKey>('views.scope', 'org');
  const [query, setQuery] = ctx.ui('views.query', '');
  const [draft, setDraft] = ctx.ui<CreateDraft>('views.create', EMPTY_DRAFT);
  const entries = viewEntries(vs);
  const blockName = (id: BlockId) => v.blocks[id].name;

  const counts: Record<ViewScopeKey, number> = {
    org: entries.filter((e) => e.adopted).length,
    sector: entries.filter((e) => e.seed && e.scope === 'sector').length,
    standard: entries.filter((e) => e.seed && e.scope === 'standard').length,
  };
  const inScope = entries.filter((e) => (scope === 'org' ? e.adopted : e.seed && e.scope === scope));
  const q = query.trim().toLowerCase();
  const shown = q
    ? inScope.filter((e) => `${e.name} ${e.description} ${e.blocks.map(blockName).join(' ')}`.toLowerCase().includes(q))
    : inScope;

  const card = (e: ViewEntry): ViewCardModel => ({
    id: e.id,
    name: e.name,
    description: e.description,
    blocks: e.blocks.map((b, i) => ({ key: `${b}-${i}`, label: blockName(b), tone: BLOCK_TONE[b] })),
    steps: activeSteps(e, vs).map((s) => ({ id: `${s.flow}:${s.step}`, label: s.label, onOpen: () => ctx.go(P.flowStep(s.flow, s.step)) })),
    metric: e.adopted ? e.seed?.perMonth : undefined,
    adopted: e.adopted,
  });

  const adopt = (e: ViewEntry) => ctx.allow('edit:structure', () => {
    setVs((p) => ({ ...p, adopted: [...p.adopted.filter((id) => id !== e.id), e.id], removed: p.removed.filter((id) => id !== e.id) }));
    ctx.log(v.log.added(e.name), 'structure', P.views());
    ctx.toast({ tone: 'ok', title: v.toast.added(e.name), body: v.toast.addedBody, action: { label: v.list.where, path: P.viewWhere(e.id) } });
  });

  const duplicate = (e: ViewEntry) => ctx.allow('edit:structure', () => {
    const base = e.custom ?? undefined;
    const id = `v-${slug(e.name)}-${hashText(`${e.id}${vs.custom.length}`).toString(36).slice(0, 4)}`;
    const copy: CustomView = {
      id, name: v.list.copyOf(e.name), description: e.description, blocks: e.blocks, kind: base?.kind ?? e.kinds[0] ?? '', createdAt: ctx.now.slice(0, 10),
    };
    setVs((p) => ({ ...p, custom: [...p.custom, copy] }));
    ctx.log(v.log.created(copy.name), 'structure', P.views());
    ctx.toast({ tone: 'ok', title: v.toast.duplicated(copy.name), action: { label: v.list.where, path: P.viewWhere(id) } });
  });

  const remove = (e: ViewEntry) => ctx.allow('edit:structure', () => {
    ctx.confirm({
      title: v.confirm.removeTitle(e.name),
      body: v.confirm.removeBody,
      confirmLabel: v.list.remove,
      tone: 'danger',
      onConfirm: () => {
        setVs((p) => (e.custom
          ? { ...p, custom: p.custom.filter((c) => c.id !== e.id) }
          : { ...p, adopted: p.adopted.filter((id) => id !== e.id), removed: [...p.removed.filter((id) => id !== e.id), e.id] }));
        ctx.log(v.log.removed(e.name), 'structure', P.views());
        ctx.toast({ tone: 'info', title: v.toast.removed(e.name) });
      },
    });
  });

  const openDialog = (extra?: Partial<CreateDraft>) => setDraft({ ...EMPTY_DRAFT, ...extra, open: true });
  const onCreate = ctx.allow('edit:structure', () => openDialog());
  const onDescribe = ctx.allow('edit:structure', () => openDialog());
  const toggleBlock = (id: BlockId) => setDraft((d) => ({ ...d, blocks: d.blocks.includes(id) ? d.blocks.filter((b) => b !== id) : [...d.blocks, id] }));

  const suggest = () => {
    const text = draft.description.toLowerCase();
    const found = BLOCK_IDS.filter((b) => BLOCK_WORDS[b].some((w) => text.includes(w)));
    if (!found.length) {
      ctx.toast({ tone: 'info', title: v.toast.noBlocks, body: v.toast.noBlocksBody });
      return;
    }
    const kindWords: Array<[CaseKind, string]> = [['concessione', 'concession'], ['ricorso', 'ricors'], ['verbale', 'verbal'], ['fattura', 'fattur'], ['segnalazione', 'segnalaz'], ['irrigazione', 'irrig']];
    const kind = draft.kind || kindWords.find(([, w]) => text.includes(w))?.[0] || '';
    setDraft((d) => ({
      ...d,
      blocks: [...new Set([...d.blocks, ...found])],
      kind,
      name: d.name || d.description.trim().replace(/^[«"]|[»"]$/g, '').split(/[.,]/)[0].slice(0, 56),
    }));
    ctx.toast({ tone: 'ok', title: v.toast.proposed(found.length) });
  };

  const submit = () => {
    const nameOk = draft.name.trim().length > 0;
    const blocksOk = draft.blocks.length > 0;
    if (!nameOk || !blocksOk) {
      setDraft((d) => ({ ...d, tried: true }));
      return;
    }
    const name = draft.name.trim();
    const id = `v-${slug(name)}-${hashText(`${name}${vs.custom.length}`).toString(36).slice(0, 4)}`;
    const view: CustomView = { id, name, description: draft.description.trim() || v.create.defaultDescription(draft.blocks.map(blockName).join(', ')), blocks: draft.blocks, kind: draft.kind, createdAt: ctx.now.slice(0, 10) };
    setVs((p) => ({ ...p, custom: [...p.custom, view] }));
    setDraft(EMPTY_DRAFT);
    setScope('org');
    setQuery('');
    ctx.log(v.log.created(name), 'structure', P.views());
    ctx.toast({ tone: 'ok', title: v.toast.created(name), body: v.toast.createdBody, action: { label: v.list.where, path: P.viewWhere(id) } });
  };

  return (
    <>
      <ViewsListScreen
        copy={ctx.copy}
        scope={scope}
        onScope={setScope}
        counts={counts}
        query={query}
        onQuery={setQuery}
        cards={shown.map(card)}
        catalog={BLOCK_IDS.map((id) => ({ id, name: v.blocks[id].name, shows: v.blocks[id].shows, reads: BLOCK_READS[id], exists: BLOCK_EXISTS[id] }))}
        phone={ctx.phone}
        deniedTitle={ctx.deniedTitle('edit:structure')}
        onCreate={onCreate}
        onDescribe={onDescribe}
        onUseBlock={(id) => (ctx.can('edit:structure') ? openDialog({ blocks: [id] }) : ctx.toast({ tone: 'warn', title: ctx.deniedTitle('edit:structure') ?? '' }))}
        onOpen={(id) => () => {
          const e = entryOf(vs, id);
          if (e) ctx.go(openPath(e));
        }}
        onWhere={(id) => () => ctx.go(P.viewWhere(id))}
        onAdd={(id) => { const e = entryOf(vs, id); return e ? adopt(e) : false; }}
        onDuplicate={(id) => { const e = entryOf(vs, id); return e ? duplicate(e) : false; }}
        onRemove={(id) => { const e = entryOf(vs, id); return e ? remove(e) : false; }}
        metricLabel={(id) => (id === 'presentazione' ? v.list.createdPerMonth : v.list.opensPerMonth)}
      />
      {draft.open && (
        <CreateViewDialog
          copy={ctx.copy}
          name={draft.name}
          onName={(name) => setDraft((d) => ({ ...d, name }))}
          description={draft.description}
          onDescription={(description) => setDraft((d) => ({ ...d, description }))}
          blocks={draft.blocks}
          onToggleBlock={toggleBlock}
          onSuggest={suggest}
          kind={draft.kind}
          onKind={(kind) => setDraft((d) => ({ ...d, kind }))}
          kinds={[{ value: '', label: v.create.anyKind }, ...KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))]}
          blockOptions={BLOCK_IDS.map((id) => ({ id, name: v.blocks[id].name }))}
          error={draft.tried ? { name: draft.name.trim() ? undefined : v.create.nameRequired, blocks: draft.blocks.length ? undefined : v.create.blocksRequired } : undefined}
          onSubmit={submit}
          onClose={() => setDraft(EMPTY_DRAFT)}
        />
      )}
    </>
  );
}
