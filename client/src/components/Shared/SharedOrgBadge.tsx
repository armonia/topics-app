import { useState } from 'react';
import { Users } from 'lucide-react';
import { useSharedOrg } from '../../lib/projectSharingStore';
import { sharedTitle } from '../../lib/projectSharing';

/**
 * The mark on a project tab that says «other people can read this».
 *
 * DISCREET BUT NOT HIDDEN, which is the whole brief: it sits at the trailing
 * edge of the tab, dimmed, and goes to full opacity on hover — but it is
 * always drawn, because a warning you have to hover to discover is a warning
 * that arrives after you have typed.
 *
 * WHY IT IS NOT `ProjectFavicon`. That component renders NOTHING when a
 * project ships no icon file — a hard product decision: only a real shipped
 * icon earns the space, no monograms, no generic glyphs. This one is the
 * opposite kind of thing. It is not the project's identity, it is a fact about
 * who is watching, so an organisation with no logo still has to say it: the
 * fallback is a glyph, and that is deliberate rather than an oversight.
 *
 * THE ANCHOR IS A `data-testid`. `PaneTabBar` already carries the lesson
 * written on its own label: «i locator dei test erano agganciati alle classi
 * Tailwind, e rinominarne una li faceva passare a verde-vuoto». A styling
 * class is not an anchor.
 */
export function SharedOrgBadge({ path, size = 12, className = '' }: { path: string; size?: number; className?: string }) {
  const org = useSharedOrg(path);
  // A logo that fails to load must not leave a broken-image glyph on the tab;
  // the fallback glyph says the same thing and always draws.
  const [logoRotto, setLogoRotto] = useState(false);

  if (!org) return null;
  const titolo = sharedTitle(org);
  const logo = org.logoUrl && !logoRotto ? org.logoUrl : null;

  return (
    <span
      data-testid="pane-tab-shared-org"
      data-org-id={org.id}
      title={titolo}
      aria-label={titolo}
      role="img"
      className={`flex items-center justify-center flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity ${className}`}
      style={{ width: size, height: size }}
    >
      {logo ? (
        <img
          src={logo}
          alt=""
          draggable={false}
          width={size}
          height={size}
          // The box comes from the style, not the attributes: Tailwind's
          // preflight sets `img { height: auto }` and would collapse it onto
          // the logo's aspect ratio. Same trap `ProjectFavicon` documents.
          style={{ width: size, height: size }}
          className="rounded-[2px] object-contain"
          onError={() => setLogoRotto(true)}
        />
      ) : (
        <Users size={size} />
      )}
    </span>
  );
}
