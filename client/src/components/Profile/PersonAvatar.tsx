import { User } from 'lucide-react';
import type { ProfiloGitHubClient } from '@/lib/api';

/**
 * ONE FACE, drawn the same way everywhere.
 *
 * The avatar appeared in four components with four sets of classes, and the
 * differences were not decisions: a rounded square in one list and a circle in
 * the next is how a screen stops looking like one product. The fallback matters
 * more than the picture: a person with no GitHub login still has to occupy the
 * SAME box, or every row below shifts by nine pixels the moment somebody
 * connects an account.
 *
 * The image is `loading="lazy"` and never blocks: a face that does not arrive
 * is a detail, and GitHub avatars come from a host we do not control.
 */
export function PersonAvatar({
  github,
  size = 36,
  className = '',
}: {
  github: ProfiloGitHubClient | null;
  /** Side in pixels. The GitHub header uses 80, lists use 36. */
  size?: number;
  className?: string;
}) {
  const box: React.CSSProperties = { width: size, height: size };
  if (github?.avatarUrl) {
    return (
      <img
        src={github.avatarUrl}
        alt=""
        style={box}
        className={`flex-shrink-0 rounded-full border border-app-border object-cover ${className}`}
        loading="lazy"
      />
    );
  }
  return (
    <div
      style={box}
      className={`flex flex-shrink-0 items-center justify-center rounded-full border border-app-border bg-app-hover ${className}`}
    >
      <User size={Math.max(12, Math.round(size * 0.42))} className="text-app-text-tertiary" />
    </div>
  );
}
