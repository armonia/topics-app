/**
 * THE ADDRESS IS EDITED IN THE TAB.
 *
 * The tab already writes the address of the page (see `browserTabLabel`); this
 * is the half that lets you type over it without any row appearing under the
 * tab. The pane asks for it by bumping `addressEditRequest` in its published
 * chrome (Cmd+L, the tab menu's "edit address", the click on the active tab,
 * a blank pane that wants somewhere to go); the tab answers by swapping its
 * label for an input, in place. Enter goes there, Escape or leaving gives the
 * label back. Reported 2026-09-03: the click that focused the pane also brought
 * the address row back under a tab that was already naming the page.
 */
import { useEffect, useRef, useState } from 'react';
import { useBrowserPaneChrome } from '../../state/browserPaneChrome';
import { toNavigableUrl } from '../../lib/browserNavUrl';

export function BrowserTabAddress({ paneId, label }: { paneId: string; label: string }) {
  const chrome = useBrowserPaneChrome(paneId);
  const request = chrome?.addressEditRequest ?? 0;
  // Adjusted during the render, the way React wants a state to react to a
  // prop: a request the tab has not acted on yet opens the editor once.
  const [seen, setSeen] = useState(request);
  const [draft, setDraft] = useState<string | null>(null);
  if (request !== seen) {
    setSeen(request);
    if (request > seen) setDraft(chrome?.url ?? '');
  }
  const editing = draft !== null;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) return;
    // After the paint that mounts the input: focus and select, so a new
    // address is one keystroke away.
    const t = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    return () => clearTimeout(t);
  }, [editing]);
  if (draft === null) return <>{label}</>;
  const go = () => {
    const typed = draft.trim();
    setDraft(null);
    if (typed) chrome?.commands.navigate?.(toNavigableUrl(typed));
  };
  return (
    <input
      ref={inputRef}
      data-testid="browser-tab-address-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') go();
        else if (e.key === 'Escape') setDraft(null);
      }}
      onBlur={() => setDraft(null)}
      // The tab bar drags and selects on these: the input keeps them.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      spellCheck={false}
      autoComplete="off"
      aria-label="address"
      className="w-full min-w-0 bg-transparent outline-none text-inherit font-inherit p-0 m-0 border-0"
    />
  );
}
