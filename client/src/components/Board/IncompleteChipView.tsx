import { AlertTriangle } from 'lucide-react';

/** The line that says an agent's card is missing what it needs to finish by itself. */
export function IncompleteChipView({ chip }: { chip: { label: string; title: string } }) {
  return (
    <span
      data-testid="card-incomplete"
      title={chip.title}
      className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-compact leading-4 text-amber-800 dark:text-amber-300 md:text-mini"
    ><AlertTriangle className="h-3 w-3 shrink-0" /> {chip.label}</span>
  );
}
