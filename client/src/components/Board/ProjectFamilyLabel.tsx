import type { ProjectFamilyLabel as Label } from '../../../../shared/project-family';

/**
 * «Sito Armonia · Nuvola»: the parent stays the chip's own ink (it says which
 * product this is), the child shrinks to the design system's faint text (it
 * still says where the agent works, but as a detail, not a second identity).
 * A non-merged project renders exactly as before: one name, no divider.
 */
export function ProjectFamilyLabelText({ label, className }: { label: Label; className?: string }) {
  if (!label.parent) return <span className={className}>{label.child}</span>;
  return (
    <span className={className}>
      {label.parent}
      <span className="text-app-text-faint"> · {label.child}</span>
    </span>
  );
}
