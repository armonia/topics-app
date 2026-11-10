import type { ReactNode } from 'react';
import { Bold, Italic, List, Sparkles } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import clsx from 'clsx';
import type { Action, SourceModel } from '../types';
import { RichText } from '../primitives/RichText';
import type { DraftBlockModel, RecordModel } from './model';

/** `onClick === false`: the tool exists but does nothing here, so it is drawn disabled and loses its hover. */
function ToolButton({ label, icon: Icon, onClick, pressed }: { label: string; icon: typeof Bold; onClick?: Action; pressed?: boolean }) {
  const disabled = onClick === false;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      data-tip={label}
      disabled={disabled}
      onClick={onClick || undefined}
      className={clsx(
        'inline-flex h-6 w-6 items-center justify-center rounded-md text-app-text-secondary',
        pressed ? 'bg-primary/15 text-primary dark:text-primary-dark' : 'bg-black/[0.05] dark:bg-white/[0.08]',
        disabled ? 'cursor-default opacity-45' : !pressed && 'hover:bg-black/[0.08]',
      )}
    >
      <Icon size={13} aria-hidden="true" />
    </button>
  );
}

/**
 * A suggestion of the AI inside the draft, never merged on its own: it sits in
 * its own block, in the AI's colour, until a person accepts or discards it,
 * and it says that its sources are still to be checked.
 */
export function ProposalBlock({ text, copy, onAccept, onDiscard }: {
  text: string;
  copy: UiCopy;
  onAccept?: () => void;
  onDiscard?: () => void;
}) {
  return (
    <div className="my-4 rounded-r-md border-l-[3px] border-fuchsia-500 bg-fuchsia-500/[0.08] py-3 pl-4 pr-4">
      <p className="font-serif text-body-lg leading-7 text-app-text">{text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-1.5 font-sans text-compact text-fuchsia-700 dark:text-fuchsia-300">
        <Sparkles size={12} aria-hidden="true" />
        <span>{copy.record.aiProposal}</span>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={onAccept} className="font-semibold underline-offset-2 hover:underline">{copy.common.accept}</button>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={onDiscard} className="underline-offset-2 hover:underline">{copy.common.discard}</button>
        <span aria-hidden="true">·</span>
        <span className="text-app-text-tertiary">{copy.record.verifySources}</span>
      </div>
    </div>
  );
}

function Block({ block, copy, onOpenSource, onDecide }: {
  block: DraftBlockModel;
  copy: UiCopy;
  onOpenSource?: (s: SourceModel) => void;
  onDecide?: (decision: 'accept' | 'discard') => void;
}) {
  switch (block.kind) {
    case 'heading':
      return (
        <h2 className="mb-5 text-center font-serif text-body-lg font-bold uppercase leading-7 tracking-[0.04em] text-app-text">
          {block.lines.map((l) => <span key={l} className="block">{l}</span>)}
        </h2>
      );
    case 'paragraph':
      return (
        <p className={clsx('mt-4 font-serif text-body-lg leading-7', block.muted ? 'text-app-text-faint' : 'text-app-text', block.italic && 'italic', block.bullet && 'pl-5 -indent-3')}>
          {block.bullet && <span aria-hidden="true">• </span>}
          {block.lead && <strong className="font-bold">{block.lead} </strong>}
          <RichText text={block.text} pageLabel={copy.common.page} onOpenSource={onOpenSource} />
        </p>
      );
    case 'proposal':
      return <ProposalBlock text={block.text} copy={copy} onAccept={onDecide && (() => onDecide('accept'))} onDiscard={onDecide && (() => onDecide('discard'))} />;
  }
}

/**
 * The draft open in the middle of a record: where it is saved, the few tools it
 * needs, the page. `onProposal` receives the index of the block and the
 * decision on an AI proposal; `onTool` is shared by the four tools (`false`
 * draws them disabled); `onOpenSource` opens the citations of the paragraphs.
 */
export function DraftEditor({ draft, copy, onOpenSource, onProposal, onTool, tools, footer, phone }: {
  draft: RecordModel['draft'];
  copy: UiCopy;
  onOpenSource?: (source: SourceModel) => void;
  onProposal?: (blockIndex: number, decision: 'accept' | 'discard') => void;
  onTool?: Action;
  /** Live tools: bold, italic and list are toggles for the next paragraph, improve asks the AI. Overrides `onTool` per tool. */
  tools?: {
    bold?: { pressed: boolean; onClick?: Action };
    italic?: { pressed: boolean; onClick?: Action };
    list?: { pressed: boolean; onClick?: Action };
    improve?: Action;
  };
  /** Under the page: the box to add a paragraph. */
  footer?: ReactNode;
  /** On a phone the file name and the save line wrap onto their own row above the tools instead of ending in dots. */
  phone?: boolean;
}) {
  const r = copy.record;
  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className={clsx('flex shrink-0 items-center gap-2 px-4 md:px-10', phone ? 'flex-wrap py-2' : 'h-12')}>
        {/* Two lines: the file name may be cut, the save time and place never are. On a phone neither is cut: both wrap. */}
        <div className={clsx('min-w-0 leading-4', phone ? 'basis-full [overflow-wrap:anywhere]' : 'flex-1')}>
          <div className={clsx('text-prose text-app-text-secondary', !phone && 'truncate')} data-tip={draft.file}>{draft.file}</div>
          {draft.meta && <div className={clsx('text-compact text-app-text-tertiary', !phone && 'truncate')} data-tip={draft.meta}>{draft.meta}</div>}
        </div>
        <ToolButton label={r.bold} icon={Bold} onClick={tools?.bold ? tools.bold.onClick : onTool} pressed={tools?.bold?.pressed} />
        <ToolButton label={r.italic} icon={Italic} onClick={tools?.italic ? tools.italic.onClick : onTool} pressed={tools?.italic?.pressed} />
        <ToolButton label={r.list} icon={List} onClick={tools?.list ? tools.list.onClick : onTool} pressed={tools?.list?.pressed} />
        <button
          type="button"
          disabled={(tools ? tools.improve : onTool) === false}
          onClick={(tools ? tools.improve : onTool) || undefined}
          className={clsx(
            'inline-flex h-6 items-center gap-1 rounded-md bg-fuchsia-500/10 px-2 text-compact font-medium text-fuchsia-700 dark:text-fuchsia-300',
            (tools ? tools.improve : onTool) === false ? 'cursor-default opacity-45' : 'hover:bg-fuchsia-500/15',
          )}
        >
          <Sparkles size={12} aria-hidden="true" />{r.improve}
        </button>
      </div>
      <article className="min-h-0 flex-1 overflow-y-auto px-4 md:px-10 pb-10 pt-3">
        <div className="mx-auto max-w-[720px]">
          {draft.blocks.map((b, i) => (
            <Block key={i} block={b} copy={copy} onOpenSource={onOpenSource} onDecide={onProposal && ((decision) => onProposal(i, decision))} />
          ))}
          {footer && <div className="mt-8">{footer}</div>}
        </div>
      </article>
    </section>
  );
}
