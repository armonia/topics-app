/**
 * MarkdownPreview — the rendered side of a `.md` file open in `FilePane`.
 *
 * It lives in its own module for ONE reason: `rehype-raw`. That plugin is the
 * only thing in the client that pulls in `parse5`, and parse5 alone was 96% of
 * the FilePane chunk (157 KB raw / 45 KB gz) — paid on every file open, for a
 * preview that is off by default and that `panePreload` warms inside the first
 * frame's gate. Keeping the import HERE means Vite puts parse5 in this chunk,
 * which is only fetched when someone actually asks for the preview.
 *
 * The raw HTML support is not optional decoration: a README is badges, a
 * `<details>` block, an `<img align>`. Rendering it once without `rehype-raw`
 * and once with would show a frame of escaped tags and then a jump, so the
 * plugin is not lazy — the whole preview is.
 */
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { markdownComponents, MarkdownBaseDirContext, MarkdownImageResolverContext } from '../MessageContent';
import { DeepLinkAnchor } from '../ChatMarkdown';

/**
 * What raw HTML may not put on the page of an `untrusted` file: the elements
 * that run code or load another document (`<iframe srcdoc>` runs its script
 * with the app's origin, and the shell has no CSP), and those that act on the
 * whole page instead of their own box (a `<base>` moves every relative request
 * of the app, a `<meta refresh>` or a `<form>` navigates it, a `<style>` or a
 * stylesheet restyles it).
 */
const ACTIVE_ELEMENTS = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'base', 'meta', 'link', 'style', 'form'];

/**
 * A link of an `untrusted` file. A web address opens the way every link of the
 * app does. A relative one names a file of that repository at that revision,
 * which the app cannot open: followed, it would navigate the app's own page
 * away, so it stays text, its target in the tooltip.
 */
function UntrustedLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href && /^[a-z][a-z0-9+.-]*:/i.test(href)) return <DeepLinkAnchor href={href}>{children}</DeepLinkAnchor>;
  return <span title={href} className="underline decoration-dotted">{children}</span>;
}

const UNTRUSTED_COMPONENTS: Components = { ...markdownComponents, a: UntrustedLink };

/**
 * `resolveImage`: where a relative image is read, for a `.md` that is not the
 * copy on disk (the diff panel renders one at a revision). Absent, images
 * resolve against `baseDir` on disk as they always did.
 *
 * `untrusted`: a file someone else wrote and nobody has reviewed yet (a
 * delivery in the diff panel). Nothing in it runs, no link of it leaves the
 * app, and nothing it draws leaves its box: a `style="position:fixed"`, or
 * the app's own `fixed inset-0` classes, would lay a box over the whole window
 * and its buttons. Paint containment makes the preview the containing block,
 * the stacking context and the clip of every box in it. `FilePane` shows the
 * owner's own disk and renders as it always did.
 */
export default function MarkdownPreview({ content, baseDir, resolveImage, untrusted = false }: {
  content: string;
  baseDir: string;
  resolveImage?: (src: string) => string | null;
  untrusted?: boolean;
}) {
  return (
    <MarkdownBaseDirContext.Provider value={baseDir}>
      <MarkdownImageResolverContext.Provider value={resolveImage ?? null}>
        <div className={`h-full overflow-auto px-6 py-4 prose dark:prose-invert prose-sm max-w-none prose-img:inline-block prose-img:my-1 prose-p:my-2${untrusted ? ' contain-paint' : ''}`}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={untrusted ? UNTRUSTED_COMPONENTS : markdownComponents}
            disallowedElements={untrusted ? ACTIVE_ELEMENTS : undefined}
          >
            {content}
          </ReactMarkdown>
        </div>
      </MarkdownImageResolverContext.Provider>
    </MarkdownBaseDirContext.Provider>
  );
}
