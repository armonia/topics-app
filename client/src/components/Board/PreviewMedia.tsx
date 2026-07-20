import { getMediaUrl } from '../../lib/api';
import { openExternalOnce } from '../../lib/openExternal';

// Extensions that render as a <video> instead of an <img>. Tolerates a trailing
// query/hash (getMediaUrl builds a `?path=…` URL, but the check runs on the raw
// stored path, which is a bare filesystem path — the suffix guard is defensive).
const VIDEO_RE = /\.(webm|mp4|mov|m4v)(\?|#|$)/i;

/** True when the preview media path is a video clip (a review recording). */
export function isVideoMedia(path: string | null | undefined): boolean {
  return !!path && VIDEO_RE.test(path);
}

/**
 * A task's review-evidence preview — a screenshot (`<img>`) OR a video clip
 * (`<video>`), chosen by file extension. Behavioural/UI tasks (auto-scroll, a
 * box that opens/closes, a streaming answer) deliver a short Playwright /
 * spec-flow recording that a static image cannot convey; static UI still
 * delivers a screenshot. Same media path + allowlist for both, served by
 * /api/media (Range-enabled for video seeking).
 *
 * `card`   — compact living thumbnail: a video plays muted + looped inline (the
 *            motion IS the evidence); an image is static.
 * `drawer` — review surface: a video gets full controls; an image is click-to-
 *            open at full size (target=_blank is dead in WKWebView → openExternal).
 */
export function PreviewMedia({ path, variant, className }: {
  path: string;
  variant: 'card' | 'drawer';
  className?: string;
}) {
  const url = getMediaUrl(path);

  if (isVideoMedia(path)) {
    return (
      <video
        src={url}
        title={variant === 'drawer' ? 'Clip di review della consegna' : undefined}
        className={className}
        muted
        playsInline
        preload="metadata"
        draggable={false}
        // card: autoplay + loop so the behaviour shows at a glance (muted, so no
        // sound spam); drawer: full controls for a deliberate review.
        {...(variant === 'card' ? { autoPlay: true, loop: true } : { controls: true })}
      />
    );
  }

  const clickable = variant === 'drawer';
  return (
    <img
      src={url}
      alt={clickable ? 'Anteprima della consegna' : ''}
      title={clickable ? 'Apri a grandezza piena' : undefined}
      loading="lazy"
      draggable={false}
      onClick={clickable ? () => openExternalOnce(url) : undefined}
      className={clickable ? `${className ?? ''} cursor-zoom-in`.trim() : className}
    />
  );
}
