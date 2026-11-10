import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { BookOpen, ChevronRight, Lock, PanelLeft } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { StateChip } from '../contracts/StateChip';
import { TextArea } from '../primitives/Field';
import { KeyValue, PanelHeading, PanelSection, SectionLabel } from '../primitives/Panel';
import { PanelColumn } from './PanelColumn';
import { UsageGroups } from './UsageGroups';
import { VersionList } from './VersionList';
import { RichText } from '../primitives/RichText';
import { PaneHeader } from '../shell/PaneHeader';
import type { ArticleModel, CollectionModel, KnowledgeModel, KnowledgeTab, UsageGroupModel, VersionModel } from './model';
import { FOCUS_RING } from '../shell/pressable';


/**
 * The collections of an organization's knowledge, one level of documents under
 * each. Headers and documents are controls only when their handler is passed;
 * `expandedCollections` lets the caller own which collections are open.
 */
export function CollectionTree({ collections, selectedId, copy, expandedCollections, onToggleCollection, onSelectItem, phone }: {
  collections: CollectionModel[];
  selectedId: string;
  copy: UiCopy;
  expandedCollections?: string[];
  onToggleCollection?: (collectionId: string) => void;
  onSelectItem?: (itemId: string) => void;
  /** On a phone the tree sits above the text, full width. */
  phone?: boolean;
}) {
  return (
    <nav aria-label={copy.knowledge.collections} className={clsx(phone ? 'max-h-[50dvh] w-full overflow-y-auto border-b' : 'h-full w-[230px] shrink-0 overflow-y-auto border-r', 'border-app-border px-2.5 py-3')}>
      <SectionLabel className="mb-2 px-1">{copy.knowledge.collections}</SectionLabel>
      <ul className="space-y-1">
        {collections.map((c) => {
          const expanded = expandedCollections ? expandedCollections.includes(c.id) : !!c.expanded;
          const headerClass = 'flex h-9 items-center gap-1.5 rounded-lg bg-black/[0.04] px-2.5 text-prose font-medium text-app-text dark:bg-white/[0.05]';
          const headerContent = (
            <>
              <ChevronRight size={12} className={clsx('shrink-0 text-app-text-tertiary transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              {c.locked && <Lock size={13} className="shrink-0 text-app-text-tertiary" aria-label={copy.knowledge.locked} />}
            </>
          );
          return (
            <li key={c.id}>
              {onToggleCollection ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => onToggleCollection(c.id)}
                  className={clsx(headerClass, 'w-full cursor-pointer text-left hover:bg-black/[0.07]', FOCUS_RING)}
                >
                  {headerContent}
                </button>
              ) : (
                <div className={headerClass}>{headerContent}</div>
              )}
              {expanded && c.items?.length ? (
                <ul className="ml-3 mt-1 space-y-1">
                  {c.items.map((it) => {
                    const selected = it.id === selectedId;
                    const itemClass = clsx(
                      'flex h-8 items-center rounded-lg px-2.5 text-prose',
                      selected ? 'bg-black/[0.07] font-medium text-app-text dark:bg-white/[0.12]' : 'text-app-text-secondary',
                    );
                    return onSelectItem ? (
                      <li key={it.id}>
                        <button
                          type="button"
                          aria-current={selected || undefined}
                          onClick={() => onSelectItem(it.id)}
                          className={clsx(itemClass, 'w-full cursor-pointer text-left', !selected && 'hover:bg-black/[0.05] hover:text-app-text', FOCUS_RING)}
                        >
                          {it.label}
                        </button>
                      </li>
                    ) : (
                      <li key={it.id} aria-current={selected || undefined} className={itemClass}>
                        {it.label}
                      </li>
                    );
                  })}
                </ul>
              ) : expanded ? (
                <p className="ml-3 mt-1 px-2.5 text-compact text-app-text-tertiary">{c.locked ? copy.knowledge.locked : copy.preview.emptyCollection}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The form that loads the wording of an article that is still missing: a box to
 * paste it in, and the words that say where the official text comes from.
 */
function PasteForm({ articleId, officialSource, copy, onPaste, onDone, onCancel }: {
  articleId: string;
  officialSource: string;
  copy: UiCopy;
  /** Called with the trimmed text; an empty one is the caller's to answer. */
  onPaste: (articleId: string, text: string) => void;
  /** The text was kept: close the form. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState('');
  const k = copy.knowledgeMore.doc;
  return (
    <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <TextArea label={k.pasteLabel} hint={k.pasteHint(officialSource)} value={draft} onChange={setDraft} rows={4} placeholder={k.pastePlaceholder} />
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={() => { onPaste(articleId, draft.trim()); if (draft.trim()) onDone(); }}>{k.pasteSave}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>{k.pasteCancel}</Button>
      </div>
    </div>
  );
}

/**
 * One paragraph of a law as a card: its text with the passages rules come from,
 * and those rules. `focused` draws the highlight a flow step has; `onFocus`
 * makes the card a control that asks the caller to focus it. A paragraph whose
 * wording is not loaded says what it is about and where the text comes from,
 * and with `onPasteText` offers to load it.
 */
export function ArticleCard({ article, copy, focused, onFocus, onRuleAction, onPasteText, officialSource }: {
  article: ArticleModel;
  copy: UiCopy;
  focused?: boolean;
  onFocus?: (articleId: string) => void;
  /** Called with the rule's words when a derived rule is pressed. */
  onRuleAction?: (rule: string) => void;
  onPasteText?: (articleId: string, text: string) => void;
  /** Where the official text of the document is loaded from. */
  officialSource?: string;
}) {
  const [pasting, setPasting] = useState(false);
  const k = copy.knowledgeMore.doc;
  return (
    <article
      data-focus={focused ? 'true' : undefined}
      ref={(el) => {
        // Brings the focused paragraph into view once, when it appears.
        if (el && focused && el.dataset.seen !== '1') {
          el.dataset.seen = '1';
          el.scrollIntoView?.({ block: 'nearest' });
        }
      }}
      {...(onFocus
        ? {
            role: 'button',
            tabIndex: 0,
            /* one article is the focused one: «current» in the list, not a toggle */
            'aria-current': focused || undefined,
            onClick: () => onFocus(article.id),
            onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onFocus(article.id);
              }
            },
          }
        : {})}
      className={clsx(
        'rounded-lg border bg-surface px-4 py-3.5',
        focused ? 'border-primary shadow-[0_0_0_3px_rgba(0,102,255,0.15)]' : 'border-app-border',
        onFocus && 'cursor-pointer',
        onFocus && !focused && 'hover:border-app-border-light',
        onFocus && FOCUS_RING,
      )}
    >
      <header className="mb-1.5 flex flex-wrap items-start gap-x-3 gap-y-1">
        <h3 className="min-w-0 flex-1 basis-48 text-prose font-semibold text-app-text">{article.heading}</h3>
        {article.source && <Chip>{article.source}</Chip>}
        {article.pending && <Chip tone="amber">{k.textToLoad}</Chip>}
      </header>
      {article.pending ? (
        <div>
          <p className="text-body-lg leading-7 text-app-text-secondary">{article.pending.subject}</p>
          <p className="mt-1 text-compact text-app-text-tertiary">{k.officialSourceIs(article.pending.officialSource)}</p>
          {onPasteText && !pasting && (
            <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
              <Button size="sm" onClick={() => setPasting(true)}>{k.pasteOpen}</Button>
            </div>
          )}
          {onPasteText && pasting && (
            <PasteForm
              articleId={article.id}
              officialSource={officialSource ?? article.pending.officialSource}
              copy={copy}
              onPaste={onPasteText}
              onDone={() => setPasting(false)}
              onCancel={() => setPasting(false)}
            />
          )}
        </div>
      ) : (
        <p className="text-body-lg leading-7 text-app-text-body">
          <RichText text={article.text} pageLabel={copy.common.page} />
        </p>
      )}
      {article.rules?.length ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <span className="text-compact text-app-text-tertiary">{copy.knowledge.derivedRules}</span>
          {article.rules.map((r) => (onRuleAction
            ? (
              <button key={r} type="button" onClick={() => onRuleAction(r)} className={clsx('rounded hover:opacity-80', FOCUS_RING)}>
                <Chip tone="blue">{r}</Chip>
              </button>
            )
            : <Chip key={r} tone="blue">{r}</Chip>))}
        </div>
      ) : null}
    </article>
  );
}

/** The records that cite a paragraph, one row each; a button only when the caller can open a record. */
function UsageRows({ usedBy, onOpenRecord, copy }: {
  usedBy: NonNullable<ArticleModel['usedBy']>;
  onOpenRecord?: (id: string) => void;
  copy: UiCopy;
}) {
  if (!usedBy.length) return <p className="text-compact text-app-text-tertiary">{copy.preview.noUsage}</p>;
  return (
    <ul className="space-y-0.5">
      {usedBy.map((u) => {
        const rowClass = 'flex w-full items-center gap-2 rounded-md -mx-2 px-2 py-1.5 text-left';
        const content = (
          <>
            <span className="min-w-0 flex-1">
              <span className="block text-prose font-semibold text-app-text">{u.title}</span>
              <span className="block text-compact text-app-text-tertiary">{u.detail}</span>
            </span>
            {onOpenRecord && <ChevronRight size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />}
          </>
        );
        return (
          <li key={u.id}>
            {onOpenRecord ? (
              <button type="button" onClick={() => onOpenRecord(u.id)} className={clsx(rowClass, 'hover:bg-app-hover', FOCUS_RING)}>
                {content}
              </button>
            ) : (
              <div className={rowClass}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A document of the knowledge base (x03), split by article and paragraph so
 * every answer can cite the exact one: the collections on the left, the text
 * with the rules derived from it in the middle, and on the right how the AI
 * uses it, its facts, and what happens to the rules when the law changes.
 * The three tabs (text, versions, used by) are all live when the caller passes
 * their data; the original-signed button and the panel rows are actions the
 * caller resolves.
 */
export function KnowledgeScreen({
  doc, copy, tab = 'text', onTabChange,
  focusArticleId, onFocusArticle, onOpenRecord,
  selectedItemId, onSelectItem, expandedCollections, onToggleCollection, children, loaded = true,
  phone, versions, onOpenVersion, onLoadText, usage, onOpenUsage, actions,
  onRuleAction, onFactAction, onPasteText, officialSource, panelExtra, backSlot, belowHeader, hideTree, hideTabs,
}: {
  doc: KnowledgeModel;
  copy: UiCopy;
  tab?: KnowledgeTab;
  onTabChange?: (tab: KnowledgeTab) => void;
  focusArticleId?: string;
  onFocusArticle?: (articleId: string) => void;
  onOpenRecord?: (recordId: string) => void;
  selectedItemId?: string;
  onSelectItem?: (itemId: string) => void;
  expandedCollections?: string[];
  onToggleCollection?: (collectionId: string) => void;
  children?: ReactNode;
  /**
   * False when the selected document has no data here: the header keeps only
   * its place and the side panel, which describes `doc`, is left out.
   */
  loaded?: boolean;
  phone?: boolean;
  /** The texts the document has had; the tab shows them when given. */
  versions?: VersionModel[];
  onOpenVersion?: (versionId: string) => void;
  /** Loads the official text of the document. */
  onLoadText?: () => void;
  /** What cites the document, by kind; the tab shows it when given. */
  usage?: UsageGroupModel[];
  onOpenUsage?: (groupId: string, rowId: string) => void;
  /** Buttons at the right of the header (the signed original). */
  actions?: ReactNode;
  onRuleAction?: (token: string) => void;
  onFactAction?: (token: string) => void;
  onPasteText?: (articleId: string, text: string) => void;
  officialSource?: string;
  /** Rows after the facts of the side panel (the follow switch). */
  panelExtra?: ReactNode;
  /** The way back, at the start of the header. */
  backSlot?: ReactNode;
  /** A band across the whole width under the header (the strips of the section and of the document). */
  belowHeader?: ReactNode;
  /** Leaves the tree of collections out: the places are reached by address. */
  hideTree?: boolean;
  /** Leaves the switch of text, versions and uses out: the caller shows them as places. */
  hideTabs?: boolean;
}) {
  const k = copy.knowledge;
  const p = doc.panel;
  const [treeOpen, setTreeOpen] = useState(false);
  const focused = focusArticleId ? doc.articles.find((a) => a.id === focusArticleId) : undefined;
  const versionCount = versions ? versions.length : 3;
  const tree = (
    <CollectionTree
      collections={doc.collections}
      selectedId={selectedItemId ?? doc.selectedId}
      copy={copy}
      expandedCollections={expandedCollections}
      onToggleCollection={onToggleCollection}
      onSelectItem={onSelectItem}
      phone={phone}
    />
  );
  const buttons = loaded ? (
    <>
      {actions}
      {!hideTabs && (
        <SegmentedControl
          value={tab}
          onChange={(v) => onTabChange?.(v)}
          ariaLabel={k.tabsLabel}
          options={[{ value: 'text', label: k.text }, { value: 'versions', label: k.versions(versionCount) }, { value: 'usedBy', label: k.usedBy }]}
        />
      )}
    </>
  ) : null;
  let body: ReactNode = children;
  if (!body && tab === 'versions' && versions) {
    body = <VersionList versions={versions} copy={copy} onOpen={onOpenVersion} onLoad={onLoadText} />;
  } else if (!body && tab === 'usedBy' && usage) {
    body = <UsageGroups groups={usage} copy={copy} onOpen={(g, r) => onOpenUsage?.(g, r)} />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={doc.crumbs} leading={backSlot} status={loaded && <StateChip tone={doc.status.tone}>{doc.status.text}</StateChip>}>{!phone && buttons}</PaneHeader>
      {phone && loaded && (!hideTabs || actions) && <div className="flex flex-wrap items-center gap-2 border-b border-app-border px-4 py-2">{buttons}</div>}
      {belowHeader}
      <div className={clsx('flex min-h-0 flex-1', phone ? 'flex-col overflow-y-auto' : 'flex-row')}>
        {hideTree ? null : phone ? (
          <div className="shrink-0 border-b border-app-border px-3 py-2">
            <Button size="sm" icon={PanelLeft} onClick={() => setTreeOpen(!treeOpen)}>{k.collections}</Button>
            {treeOpen && <div className="mt-2">{tree}</div>}
          </div>
        ) : tree}
        {/* without the tree the text starts on the same edge as the crumbs and the strips above it (the pane's side gutter) */}
        <section className={clsx('min-w-0 px-4 py-5', !hideTree && 'md:px-7', phone ? 'shrink-0' : 'flex-1 overflow-y-auto')}>
          {body ?? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-headline font-semibold tracking-[-0.01em] text-app-text">{doc.title}</h2>
                {doc.subtitle && <span className="text-prose text-app-text-tertiary">{doc.subtitle}</span>}
              </div>
              <div className="mb-4 mt-2.5 flex flex-wrap gap-1.5">
                {doc.articleTabs.map((t) => {
                  const active = focusArticleId ? t.articleId === focusArticleId || doc.articles.find((a) => a.id === focusArticleId)?.id.startsWith(t.id) === true : !!t.active;
                  const chip = (
                    <Chip tone={active ? 'blue' : 'neutral'} strong={active} className={onFocusArticle && t.articleId && !active ? 'group-hover:bg-black/[0.08]' : undefined}>
                      {t.label}
                    </Chip>
                  );
                  const articleId = t.articleId;
                  return onFocusArticle && articleId ? (
                    <button
                      key={t.id}
                      type="button"
                      aria-current={active || undefined}
                      onClick={() => onFocusArticle(articleId)}
                      className={clsx('group cursor-pointer rounded', FOCUS_RING)}
                    >
                      {chip}
                    </button>
                  ) : (
                    <span key={t.id} className={onFocusArticle ? 'cursor-default opacity-45' : undefined} data-tip={onFocusArticle ? copy.preview.notLoaded : undefined}>{chip}</span>
                  );
                })}
              </div>
              <div className="space-y-3">
                {doc.articles.map((a) => (
                  <ArticleCard
                    key={a.id}
                    article={a}
                    copy={copy}
                    focused={a.id === focusArticleId}
                    onFocus={onFocusArticle}
                    onRuleAction={onRuleAction}
                    onPasteText={onPasteText}
                    officialSource={officialSource}
                  />
                ))}
              </div>
            </>
          )}
        </section>
        {loaded && <PanelColumn phone={phone} width={330}>
          <PanelHeading tag={p.tag} tagIcon={BookOpen} title={p.title}>{p.description}</PanelHeading>
          {focused && (
            <PanelSection label={`${k.usedBy} · ${focused.heading}`}>
              <UsageRows usedBy={focused.usedBy ?? []} onOpenRecord={onOpenRecord} copy={copy} />
            </PanelSection>
          )}
          <PanelSection label={p.factsLabel}>
            {p.facts.map((f) => {
              const value = f.pending ? <Chip tone="amber">{f.value}</Chip> : <span className="font-semibold">{f.value}</span>;
              return (
                <KeyValue
                  key={f.label}
                  label={f.label}
                  value={f.action && onFactAction ? (
                    <button type="button" onClick={() => onFactAction(f.action as string)} className={clsx('rounded underline-offset-2 hover:underline', FOCUS_RING)}>{value}</button>
                  ) : value}
                />
              );
            })}
            {panelExtra}
          </PanelSection>
          {p.rules.length > 0 && (
            <PanelSection label={p.rulesLabel}>
              {p.rules.map((r) => (
                <KeyValue
                  key={r.label}
                  label={r.label}
                  value={r.action && onRuleAction ? (
                    <button type="button" onClick={() => onRuleAction(r.action as string)} className={clsx('rounded font-semibold text-primary underline-offset-2 hover:underline dark:text-primary-dark', FOCUS_RING)}>{r.value}</button>
                  ) : <span className="font-semibold">{r.value}</span>}
                />
              ))}
            </PanelSection>
          )}
          {p.changeLabel && p.changeText && (
            <PanelSection label={p.changeLabel}>
              <p className="text-prose leading-6 text-app-text-secondary">{p.changeText}</p>
            </PanelSection>
          )}
        </PanelColumn>}
      </div>
    </div>
  );
}
