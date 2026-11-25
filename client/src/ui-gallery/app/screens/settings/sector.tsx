/** Settings · Sector (`k01`): the package that brings words, types and templates; the vocabulary is editable and a switch previews the labels. */
import { ArrowUpRight, Search } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import type { SectorId, TermId } from '../../../../ui/settings/model';
import { P } from '../../paths';
import { settingsFrame } from '../settings-frame';
import { Block, Callout, Notes } from '../../../../ui/settings/Block';
import { BringGroup, BringItem, LabelPreview, PackageCards, VocabularyList } from '../../../../ui/settings/Sector';
import { Button } from '../../../../ui/primitives/Button';
import { TextField } from '../../../../ui/primitives/Field';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { SECTOR_PACKAGES, TERM_IDS, type SectorPackage } from '../../../../ui/fixtures/settings';
import { adminGate } from './helpers';

interface SectorState {
  active: SectorId;
  /** Words edited by hand, per package. */
  overrides: Partial<Record<SectorId, Partial<Record<TermId, string>>>>;
}

const INITIAL: SectorState = { active: 'bonifica', overrides: {} };

const wordsOf = (pkg: SectorPackage, state: SectorState): Record<TermId, string> => ({ ...pkg.vocabulary, ...(state.overrides[pkg.id] ?? {}) });

export function SectorPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.settings;
  const s = c.sector;
  const gate = adminGate(ctx);
  const [state, setState] = ctx.slice<SectorState>('sector', INITIAL);
  const [previewId, setPreviewId] = ctx.ui<SectorId>('settore.preview', state.active);
  const [drafts, setDrafts] = ctx.ui<Partial<Record<TermId, string>>>('settore.drafts', {});
  const [query, setQuery] = ctx.ui<string>('settore.q', '');

  const active = SECTOR_PACKAGES.find((p) => p.id === state.active)!;
  const preview = SECTOR_PACKAGES.find((p) => p.id === previewId) ?? active;
  const activeWords = wordsOf(active, state);
  const previewing = preview.id !== active.id;
  const previewWords = wordsOf(preview, state);

  const saveWord = (term: TermId) => {
    const next = (drafts[term] ?? '').trim();
    if (!next || next === activeWords[term]) {
      setDrafts((prev) => { const { [term]: _drop, ...rest } = prev; return rest; });
      return;
    }
    const from = activeWords[term];
    setState((prev) => ({ ...prev, overrides: { ...prev.overrides, [active.id]: { ...(prev.overrides[active.id] ?? {}), [term]: next } } }));
    setDrafts((prev) => { const { [term]: _drop, ...rest } = prev; return rest; });
    ctx.log(s.log.word(s.vocab.terms[term], from, next), 'setting', ctx.path);
    ctx.toast({ tone: 'ok', title: c.common.saved(s.vocab.terms[term]) });
  };

  const resetWord = (term: TermId) => {
    setState((prev) => {
      const { [term]: _drop, ...rest } = prev.overrides[active.id] ?? {};
      return { ...prev, overrides: { ...prev.overrides, [active.id]: rest } };
    });
    setDrafts((prev) => { const { [term]: _drop, ...rest } = prev; return rest; });
    ctx.log(s.log.wordReset(s.vocab.terms[term]), 'setting', ctx.path);
  };

  const resetAll = () => {
    setState((prev) => ({ ...prev, overrides: { ...prev.overrides, [active.id]: {} } }));
    setDrafts({});
    ctx.log(s.log.allReset, 'setting', ctx.path);
    ctx.toast({ tone: 'ok', title: s.log.allReset });
  };

  const activate = () =>
    ctx.confirm({
      title: s.confirm.title(preview.name),
      body: s.confirm.body(preview.name),
      confirmLabel: s.confirm.label,
      onConfirm: () => {
        setState((prev) => ({ ...prev, active: preview.id }));
        setDrafts({});
        ctx.log(s.log.activated(preview.name), 'setting', ctx.path);
        ctx.toast({ tone: 'ok', title: s.confirm.toast(preview.name), body: s.confirm.toastBody });
      },
    });

  const q = query.trim().toLowerCase();
  const rows = TERM_IDS.filter((t) => !q || [s.vocab.terms[t], activeWords[t], previewWords[t]].some((x) => x.toLowerCase().includes(q)));
  const editedCount = TERM_IDS.filter((t) => state.overrides[active.id]?.[t] !== undefined).length;

  const flowOf = (id?: string) => (id ? FLOWS.find((f) => f.id === id) : undefined);
  const pathOfFlow = (id: string) => (FLOWS.find((f) => f.id === id)?.org === 'orbit' ? P.orbitFlow(id) : P.flow(id));

  return settingsFrame(ctx, 'settore', {
    children: (
      <div className="flex flex-col gap-4">
        <p className="text-prose leading-5 text-app-text-secondary">{s.intro}</p>

        <Block title={s.packagesTitle}>
          <PackageCards
            ariaLabel={s.packagesTitle}
            items={SECTOR_PACKAGES.map((p) => ({
              id: p.id,
              name: p.name,
              org: p.org,
              badges: [
                ...(p.id === active.id ? [{ label: s.badges.active, tone: 'green' as const }] : []),
                ...(p.example ? [{ label: s.badges.example, tone: 'neutral' as const }] : []),
                ...(p.id === preview.id && p.id !== active.id ? [{ label: s.badges.preview, tone: 'blue' as const }] : []),
              ],
              summary: [
                p.caseTypes.length ? `${p.caseTypes.length} ${s.brings.caseTypes.toLowerCase()}` : s.brings.undefined,
                `${p.templates.length} ${s.brings.templates.toLowerCase()}`,
              ].join(' · '),
              selected: p.id === preview.id,
              onSelect: () => setPreviewId(p.id),
            }))}
          />
        </Block>

        <Block
          title={s.preview.title}
          description={s.preview.intro(preview.name)}
          actions={
            previewing ? (
              <Button variant="primary" onClick={ctx.allow('admin', activate)} title={gate.title}>{s.activate(preview.name)}</Button>
            ) : (
              <Chip tone="green">{s.isActive}</Chip>
            )
          }
        >
          <LabelPreview lines={s.preview.lines(previewWords).map((l) => l)} />
        </Block>

        <Block
          title={s.vocab.title}
          description={s.vocab.intro(active.name)}
          actions={editedCount > 0 ? <Button variant="ghost" onClick={ctx.allow('admin', resetAll)} title={gate.title}>{s.vocab.resetAll}</Button> : undefined}
          bodyClassName="flex flex-col gap-3"
        >
          <TextField size="sm" type="search" icon={Search} value={query} onChange={setQuery} placeholder={s.vocab.search} className="w-full sm:w-64" />
          {rows.length === 0 ? (
            <EmptyState title={s.vocab.empty} action={<Button onClick={() => setQuery('')}>{c.common.clear}</Button>} className="min-h-0 py-6" />
          ) : (
            <VocabularyList
              rows={rows.map((t) => {
                const saved = activeWords[t];
                const typed = drafts[t];
                const dirty = typed !== undefined && typed.trim() !== saved;
                return {
                  id: t,
                  generic: s.vocab.terms[t],
                  word: typed ?? saved,
                  other: previewing ? previewWords[t] : undefined,
                  edited: state.overrides[active.id]?.[t] !== undefined,
                  editLabel: s.vocab.editLabel(s.vocab.terms[t]),
                  onChange: (v) => setDrafts((prev) => ({ ...prev, [t]: v })),
                  onSave: dirty ? () => saveWord(t) : undefined,
                  onReset: () => resetWord(t),
                };
              })}
              labels={{ generic: s.vocab.columns.generic, word: s.vocab.columns.word, other: previewing ? s.vocab.columns.other(preview.name) : undefined }}
              resetLabel={s.vocab.reset}
              saveLabel={c.common.save}
              editedLabel={s.vocab.edited}
              disabled={gate.disabled}
              disabledTitle={gate.title}
            />
          )}
        </Block>

        <Block title={s.brings.title(preview.name)} bodyClassName="grid gap-5 sm:grid-cols-2">
          <BringGroup title={s.brings.caseTypes} count={preview.caseTypes.length ? s.brings.count(preview.caseTypes.length) : undefined}>
            {preview.caseTypes.length === 0 && <BringItem label={s.brings.undefined} />}
            {preview.caseTypes.map((t) => (
              <BringItem key={t.id} label={`${t.id} · ${t.label}`} detail={t.perMonth !== undefined ? s.brings.perMonth(t.perMonth) : undefined} />
            ))}
          </BringGroup>
          <BringGroup title={s.brings.templates} count={s.brings.count(preview.templates.length)}>
            {preview.templates.map((t) => {
              const flow = flowOf(t.flow);
              return (
                <BringItem
                  key={t.id}
                  label={t.label}
                  action={
                    flow ? (
                      <Button size="sm" variant="ghost" icon={ArrowUpRight} onClick={() => ctx.go(pathOfFlow(flow.id))}>{s.brings.openFlow}</Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={ctx.allow('edit:structure', () => ctx.go(P.flowNew()))} title={ctx.deniedTitle('edit:structure')}>{s.brings.useTemplate}</Button>
                    )
                  }
                />
              );
            })}
          </BringGroup>
          <BringGroup title={s.brings.connections}>
            {preview.connections.length === 0 && <BringItem label={s.brings.undefined} />}
            {preview.connections.map((n) => (
              <BringItem key={n} label={n} action={<Button size="sm" variant="ghost" icon={ArrowUpRight} onClick={() => ctx.go(P.programs())}>{s.brings.openPrograms}</Button>} />
            ))}
          </BringGroup>
          <BringGroup title={s.brings.norms}>
            {preview.norms.length === 0 && <BringItem label={s.brings.undefined} />}
            {preview.norms.map((n) => (
              <BringItem
                key={n.label}
                label={n.label}
                action={<Button size="sm" variant="ghost" icon={ArrowUpRight} onClick={() => ctx.go(n.item ? P.knowledgeDoc(n.item) : P.knowledge())}>{s.brings.openKnowledge}</Button>}
              />
            ))}
          </BringGroup>
          <BringGroup title={s.brings.standards}>
            {preview.standards.map((n) => (
              <BringItem key={n} label={n} action={<Button size="sm" variant="ghost" icon={ArrowUpRight} onClick={() => ctx.go(P.settings('conformita'))}>{s.brings.openStandards}</Button>} />
            ))}
          </BringGroup>
        </Block>

        <Notes items={s.help.map((h) => ({ title: h.title, text: h.text }))} />
        {gate.disabled && <Callout tone="neutral">{gate.title}</Callout>}
      </div>
    ),
  });
}
