import { useEffect, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorView, lineNumbers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';

interface DiffViewerProps {
  originalContent: string;
  modifiedContent: string;
  filename: string;
  darkMode?: boolean;
}

function getLanguageExtension(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'ts': case 'tsx':
      return javascript({ typescript: true, jsx: ext === 'tsx' });
    case 'js': case 'mjs': case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'html': case 'htm':
      return html();
    case 'css': case 'scss':
      return css();
    case 'json': case 'jsonc':
      return json();
    case 'md': case 'mdx':
      return markdown();
    case 'py':
      return python();
    default:
      return null;
  }
}

const lightTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  '.cm-gutters': {
    backgroundColor: '#fafafa',
    borderRight: '1px solid #e8e8e8',
    color: '#bbb',
  },
  '.cm-changedLine': {
    backgroundColor: '#fff8e1 !important',
  },
  '.cm-changedText': {
    backgroundColor: '#ffe082 !important',
  },
  '.cm-deletedChunk': {
    backgroundColor: '#ffebee !important',
  },
  '.cm-insertedLine': {  
    backgroundColor: '#e8f5e9 !important',
  },
});

const darkThemeStyles = EditorView.theme({
  '&': {
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  '.cm-changedLine': {
    backgroundColor: 'rgba(255, 235, 59, 0.08) !important',
  },
  '.cm-changedText': {
    backgroundColor: 'rgba(255, 235, 59, 0.2) !important',
  },
  '.cm-deletedChunk': {
    backgroundColor: 'rgba(244, 67, 54, 0.1) !important',
  },
  '.cm-insertedLine': {
    backgroundColor: 'rgba(76, 175, 80, 0.1) !important',
  },
});

export function DiffViewer({ originalContent, modifiedContent, filename, darkMode = false }: DiffViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Clean up previous
    if (mergeViewRef.current) {
      mergeViewRef.current.destroy();
      mergeViewRef.current = null;
    }

    const langExt = getLanguageExtension(filename);
    const langExtensions = langExt ? [langExt] : [];
    
    const commonExtensions = [
      lineNumbers(),
      EditorState.readOnly.of(true),
      ...(darkMode
        ? [oneDark, darkThemeStyles]
        : [lightTheme, syntaxHighlighting(defaultHighlightStyle)]
      ),
      ...langExtensions,
    ];

    const mergeView = new MergeView({
      a: {
        doc: originalContent,
        extensions: [...commonExtensions],
      },
      b: {
        doc: modifiedContent,
        extensions: [...commonExtensions],
      },
      parent: containerRef.current,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });

    mergeViewRef.current = mergeView;

    return () => {
      mergeView.destroy();
      mergeViewRef.current = null;
    };
  }, [originalContent, modifiedContent, filename, darkMode]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-auto [&_.cm-mergeView]:h-full [&_.cm-editor]:outline-none [&_.cm-mergeViewEditors]:h-full [&_.cm-scroller]:overflow-auto"
    />
  );
}
