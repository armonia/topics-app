import { ArrowRight, History } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { StateChip } from '../contracts/StateChip';
import type { Tone } from '../types';
import type { VersionModel } from './model';

const TONE: Record<string, Tone> = { green: 'green', amber: 'amber', neutral: 'neutral', red: 'red', blue: 'blue', violet: 'violet', pink: 'pink' };

/**
 * The texts a document has had: the one in use, the one it replaced, the one
 * still to load. A version that is another document of the base opens it.
 */
export function VersionList({ versions, copy, onOpen, onLoad }: {
  versions: VersionModel[];
  copy: UiCopy;
  onOpen?: (versionId: string) => void;
  /** Loads the official text, for the version that is still missing. */
  onLoad?: () => void;
}) {
  const k = copy.knowledgeMore.doc;
  return (
    <ol className="space-y-2.5" aria-label={copy.knowledge.versions(versions.length)}>
      {versions.map((v) => (
        <li key={v.id} data-current={v.current || undefined} className="flex flex-wrap items-center gap-3 rounded-lg border border-app-border bg-surface px-4 py-3">
          <History size={15} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
          <div className="min-w-0 flex-1 basis-56">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-prose font-semibold text-app-text">{v.label}</span>
              <Chip tone={TONE[v.status.tone] ?? 'neutral'}>{v.status.text}</Chip>
              {v.current && <StateChip tone="green">{k.versionCurrent}</StateChip>}
            </div>
            <p className="mt-0.5 text-compact leading-5 text-app-text-secondary">{v.detail}</p>
          </div>
          {v.openLabel && onOpen && <Button size="sm" icon={ArrowRight} onClick={() => onOpen(v.id)}>{v.openLabel}</Button>}
          {v.pendingLoad && onLoad && <Button size="sm" variant="primary" onClick={onLoad}>{k.loadText}</Button>}
        </li>
      ))}
    </ol>
  );
}
