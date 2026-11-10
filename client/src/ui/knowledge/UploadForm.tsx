import { CircleAlert, Upload } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { TextArea, TextField, Select } from '../primitives/Field';
import { ProgressBar } from '../primitives/Progress';

/**
 * Loads a document into a collection. In the preview the text is pasted in,
 * because a file picker would leave the page; the document is split into
 * paragraphs and from then on the question box answers from it.
 */
export function UploadForm({ copy, title, onTitle, collection, onCollection, collections, text, onText, onSubmit, onCancel, progress, error }: {
  copy: UiCopy;
  title: string;
  onTitle: (v: string) => void;
  collection: string;
  onCollection: (v: string) => void;
  collections: Array<{ value: string; label: string }>;
  text: string;
  onText: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** While the document is being read: how far, and what the step is. */
  progress?: { value: number; label: string };
  /** Why the last try failed. */
  error?: string;
}) {
  const c = copy.knowledgeMore.collections;
  return (
    <Card title={c.uploadTitle} icon={Upload}>
      <div className="grid gap-3 md:grid-cols-2">
        <TextField label={c.uploadFieldTitle} value={title} onChange={onTitle} placeholder={c.uploadPlaceholderTitle} disabled={!!progress} />
        <Select label={c.uploadFieldCollection} value={collection} options={collections} onChange={onCollection} disabled={!!progress} />
        <TextArea className="md:col-span-2" label={c.uploadFieldText} hint={c.uploadTextHint} value={text} onChange={onText} rows={5} placeholder={c.uploadPlaceholderText} disabled={!!progress} />
      </div>
      {error && !progress && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-compact text-rose-600 dark:text-rose-400">
          <CircleAlert size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      {progress ? (
        <ProgressBar className="mt-3" value={progress.value} label={progress.label} />
      ) : (
        <div className="mt-3 flex gap-2">
          <Button variant="primary" icon={Upload} onClick={onSubmit}>{c.uploadSubmit}</Button>
          <Button variant="ghost" onClick={onCancel}>{c.uploadCancel}</Button>
        </div>
      )}
    </Card>
  );
}
