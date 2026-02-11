import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, indentOnInput } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';

interface CodeEditorProps {
  content: string;
  filename: string;
  readOnly?: boolean;
  onSave?: (content: string) => void;
  onChange?: (content: string) => void;
  darkMode?: boolean;
}

// Detect language extension from filename
function getLanguageExtension(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true, jsx: ext === 'tsx' });
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'html':
    case 'htm':
    case 'svelte':
    case 'vue':
      return html();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'json':
    case 'jsonc':
      return json();
    case 'md':
    case 'mdx':
    case 'markdown':
      return markdown();
    case 'py':
    case 'pyw':
      return python();
    default:
      return null;
  }
}

// Light theme matching the app's aesthetic
const lightTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  '.cm-content': {
    padding: '8px 0',
  },
  '.cm-gutters': {
    backgroundColor: '#fafafa',
    borderRight: '1px solid #e8e8e8',
    color: '#bbb',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#f0f0f0',
    color: '#999',
  },
  '.cm-activeLine': {
    backgroundColor: '#f8f8f8',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--primary)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--primary)22 !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--primary)33 !important',
  },
  '.cm-foldGutter': {
    width: '14px',
  },
});

const darkThemeOverrides = EditorView.theme({
  '&': {
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  '.cm-content': {
    padding: '8px 0',
  },
  '.cm-foldGutter': {
    width: '14px',
  },
});

export function CodeEditor({ content, filename, readOnly = true, onSave, onChange, darkMode = false }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const langCompartment = useRef(new Compartment());
  const [currentContent, setCurrentContent] = useState(content);

  // Get current content from editor
  const getContent = useCallback(() => {
    if (viewRef.current) {
      return viewRef.current.state.doc.toString();
    }
    return currentContent;
  }, [currentContent]);

  // Handle save
  const handleSave = useCallback(() => {
    if (onSave && !readOnly) {
      const text = getContent();
      onSave(text);
    }
  }, [onSave, readOnly, getContent]);

  // Create editor
  useEffect(() => {
    if (!containerRef.current) return;

    const langExt = getLanguageExtension(filename);
    const themeExts = darkMode
      ? [oneDark, darkThemeOverrides]
      : [lightTheme, syntaxHighlighting(defaultHighlightStyle)];

    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      foldGutter(),
      bracketMatching(),
      indentOnInput(),
      history(),
      readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
      themeCompartment.current.of(themeExts),
      langCompartment.current.of(langExt ? [langExt] : []),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
        {
          key: 'Mod-s',
          run: () => {
            handleSave();
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const text = update.state.doc.toString();
          setCurrentContent(text);
          onChange?.(text);
        }
      }),
      // Dark mode: use default highlight style too for non-onedark themes
      ...(darkMode ? [] : []),
    ];

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename]); // Only recreate on filename change

  // Update content when it changes externally
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      const currentDoc = view.state.doc.toString();
      if (currentDoc !== content) {
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: content },
        });
      }
    }
  }, [content]);

  // Toggle readOnly
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      view.dispatch({
        effects: readOnlyCompartment.current.reconfigure(
          EditorState.readOnly.of(readOnly)
        ),
      });
    }
  }, [readOnly]);

  // Toggle dark mode
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      const themeExts = darkMode
        ? [oneDark, darkThemeOverrides]
        : [lightTheme, syntaxHighlighting(defaultHighlightStyle)];
      view.dispatch({
        effects: themeCompartment.current.reconfigure(themeExts),
      });
    }
  }, [darkMode]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-auto [&_.cm-editor]:h-full [&_.cm-editor]:outline-none [&_.cm-scroller]:overflow-auto"
    />
  );
}
