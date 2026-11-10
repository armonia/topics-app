import { ArrowRight, FileSearch, Sparkles } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import type { SourceModel } from '../types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { RichText } from '../primitives/RichText';
import { SectionLabel } from '../primitives/Panel';
import type { AnswerModel, PassageModel } from './model';

/**
 * The answer of the question box. It is made only of passages of the
 * documents: the prose carries a numbered source after each claim, and the
 * passages are listed under it with the words that matched. When no document
 * says anything about the question it says so and does not answer.
 */
export function AnswerCard({ answer, copy, onOpenSource, onOpenPassage, onUpload }: {
  answer: AnswerModel;
  copy: UiCopy;
  onOpenSource: (source: SourceModel) => void;
  onOpenPassage: (p: PassageModel) => void;
  /** Offers to load a document, when nothing was found. */
  onUpload?: () => void;
}) {
  const c = copy.knowledgeMore.collections;
  if (answer.status === 'none') {
    return (
      <Card className="py-3" tone="amber">
        <div className="flex min-h-[160px] items-center justify-center">
          <EmptyState icon={FileSearch} title={c.noSourceTitle} action={onUpload ? <Button onClick={onUpload}>{c.noSourceUpload}</Button> : undefined} className="min-h-0 py-4">
            {c.noSourceBody(answer.question)}
          </EmptyState>
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
        <Chip tone="pink" icon={Sparkles}>{c.answerTag}</Chip>
        <span className="text-compact font-medium text-app-text-tertiary">{c.answerNote}</span>
      </div>
      <p className="text-body-lg leading-7 text-app-text-body">
        <RichText text={answer.summary} pageLabel={copy.common.page} onOpenSource={onOpenSource} />
      </p>
      <p className="mt-2.5 text-compact text-app-text-tertiary">{c.answerShared}</p>
      <div className="mt-4 border-t border-app-border pt-3">
        <SectionLabel className="mb-2">{c.sourcesLabel} · {answer.passages.length}</SectionLabel>
        <ol className="space-y-2">
          {answer.passages.map((p) => (
            <li key={p.n} className="flex items-start gap-3 rounded-lg bg-black/[0.03] px-3 py-2.5 dark:bg-white/[0.04]">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-nano font-semibold text-white" aria-hidden="true">{p.n}</span>
              <div className="min-w-0 flex-1">
                <div className="text-compact font-semibold text-app-text">{p.label}</div>
                <p className="mt-0.5 text-compact leading-5 text-app-text-secondary">
                  <RichText text={p.excerpt} pageLabel={copy.common.page} />
                </p>
              </div>
              <Button size="sm" icon={ArrowRight} onClick={() => onOpenPassage(p)}>{c.sourceOpen}</Button>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}
