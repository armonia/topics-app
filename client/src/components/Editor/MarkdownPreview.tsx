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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { markdownComponents, MarkdownBaseDirContext } from '../MessageContent';

export default function MarkdownPreview({ content, baseDir }: { content: string; baseDir: string }) {
  return (
    <MarkdownBaseDirContext.Provider value={baseDir}>
      <div className="h-full overflow-auto px-6 py-4 prose dark:prose-invert prose-sm max-w-none prose-img:inline-block prose-img:my-1 prose-p:my-2">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw]}
          components={markdownComponents}
        >
          {content}
        </ReactMarkdown>
      </div>
    </MarkdownBaseDirContext.Provider>
  );
}
