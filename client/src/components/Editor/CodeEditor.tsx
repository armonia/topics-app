import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, gutter, GutterMarker } from '@codemirror/view';
import { EditorState, Compartment, StateField, StateEffect, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, indentOnInput } from '@codemirror/language';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';

interface LineChange {
  from: number;
  to: number;
  type: 'added' | 'modified' | 'deleted';
}

interface CodeEditorProps {
  content: string;
  filename: string;
  readOnly?: boolean;
  onSave?: (content: string) => void;
  onChange?: (content: string) => void;
  darkMode?: boolean;
  initialLine?: number;
  gitChanges?: LineChange[];
  wordWrap?: boolean;
  onCursorChange?: (line: number, col: number) => void;
}

// Git gutter decorations
const setGitChanges = StateEffect.define<LineChange[]>();

class GitMarker extends GutterMarker {
  constructor(public type: 'added' | 'modified' | 'deleted') { super(); }
  toDOM() {
    const el = document.createElement('div');
    el.style.width = '3px';
    el.style.height = '100%';
    el.style.borderRadius = '1px';
    if (this.type === 'added') el.style.backgroundColor = '#22c55e';
    else if (this.type === 'modified') el.style.backgroundColor = '#3b82f6';
    else el.style.backgroundColor = '#ef4444';
    return el;
  }
}

const addedMarker = new GitMarker('added');
const modifiedMarker = new GitMarker('modified');
const deletedMarker = new GitMarker('deleted');

const gitChangesField = StateField.define<LineChange[]>({
  create() { return []; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGitChanges)) return e.value;
    }
    return value;
  },
});

function gitGutterExtension(): Extension {
  return [
    gitChangesField,
    gutter({
      class: 'cm-git-gutter',
      lineMarker(view, line) {
        const changes = view.state.field(gitChangesField);
        const lineNo = view.state.doc.lineAt(line.from).number;
        for (const c of changes) {
          if (lineNo >= c.from && lineNo <= c.to) {
            if (c.type === 'added') return addedMarker;
            if (c.type === 'modified') return modifiedMarker;
            return deletedMarker;
          }
        }
        return null;
      },
      lineMarkerChange(update) {
        return update.transactions.some(tr => tr.effects.some(e => e.is(setGitChanges)));
      },
    }),
  ];
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
  '.cm-git-gutter': {
    width: '4px',
    minWidth: '4px',
  },
  '.cm-git-gutter .cm-gutterElement': {
    padding: '0 !important',
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
  '.cm-git-gutter': {
    width: '4px',
    minWidth: '4px',
  },
  '.cm-git-gutter .cm-gutterElement': {
    padding: '0 !important',
  },
});

export function CodeEditor({ content, filename, readOnly = true, onSave, onChange, darkMode = false, initialLine, gitChanges, wordWrap = false, onCursorChange }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const langCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;
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
      closeBrackets(),
      indentOnInput(),
      history(),
      search(),
      highlightSelectionMatches(),
      autocompletion(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      gitGutterExtension(),
      readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
      themeCompartment.current.of(themeExts),
      langCompartment.current.of(langExt ? [langExt] : []),
      wrapCompartment.current.of(wordWrap ? EditorView.lineWrapping : []),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
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
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          onCursorChangeRef.current?.(line.number, head - line.from + 1);
        }
      }),
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
    // `content` NON va fra le dipendenze: ricreare l'EditorView a ogni battuta
    // distruggerebbe cursore, scroll e storia dell'undo. Il contenuto entra
    // dall'effetto di sincronizzazione qui sotto, che fa un dispatch sulla view
    // viva. Solo un file diverso giustifica una view nuova.
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

  // Update git gutter when changes arrive
  useEffect(() => {
    const view = viewRef.current;
    if (view && gitChanges) {
      view.dispatch({ effects: setGitChanges.of(gitChanges) });
    }
  }, [gitChanges]);

  // Toggle word wrap
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      view.dispatch({
        effects: wrapCompartment.current.reconfigure(
          wordWrap ? EditorView.lineWrapping : []
        ),
      });
    }
  }, [wordWrap]);

  // Scroll to line when initialLine changes
  useEffect(() => {
    const view = viewRef.current;
    if (view && initialLine && initialLine > 0) {
      const lineCount = view.state.doc.lines;
      const targetLine = Math.min(initialLine, lineCount);
      const line = view.state.doc.line(targetLine);
      view.dispatch({
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      });
    }
  }, [initialLine]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-auto [&_.cm-editor]:h-full [&_.cm-editor]:outline-none [&_.cm-scroller]:overflow-auto"
    />
  );
}
