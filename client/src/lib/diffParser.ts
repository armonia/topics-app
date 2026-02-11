/**
 * Parser for Aider-style search/replace blocks in AI messages.
 * 
 * Format:
 * path/to/file.ts
 * <<<<<<< SEARCH
 * old code here
 * =======
 * new code here
 * >>>>>>> REPLACE
 */

export interface DiffEdit {
  filePath: string;
  searchText: string;
  replaceText: string;
}

export interface MessageSegment {
  type: 'text' | 'diff';
  content?: string; // for text segments
  edit?: DiffEdit;   // for diff segments
}

const DIFF_BLOCK_REGEX = /^(.+?\.\w+)\n<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE$/gm;

/**
 * Parse message content and extract search/replace blocks mixed with text.
 */
export function parseMessageWithDiffs(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;

  // Reset regex
  DIFF_BLOCK_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = DIFF_BLOCK_REGEX.exec(content)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) segments.push({ type: 'text', content: text });
    }

    segments.push({
      type: 'diff',
      edit: {
        filePath: match[1].trim(),
        searchText: match[2],
        replaceText: match[3],
      },
    });

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) segments.push({ type: 'text', content: text });
  }

  return segments;
}

/**
 * Quick check if content contains any diff blocks.
 */
export function hasDiffBlocks(content: string): boolean {
  return /<<<<<<< SEARCH\n/.test(content) && />>>>>>> REPLACE/.test(content);
}
