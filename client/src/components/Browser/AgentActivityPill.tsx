/**
 * AgentActivityPill — a compact, NON-blocking indicator that surfaces WHEN the
 * agent is driving the browser and WHAT it's doing, shown in the browser
 * toolbar (so it never shifts/reflows the page content — the earlier native
 * implementation inset the WebContentsView by a top strip, which made the page
 * visibly jump on every tool call).
 *
 * Behaviour:
 *  - `active` reflects the live agent_active broadcast (true exactly while a
 *    browser_* tool call is in flight — see server withLock).
 *  - We LINGER ~700ms after `active` goes false so a rapid burst of tool calls
 *    shows a steady pill instead of a flicker.
 *  - `action` is the human-readable label ("Clicca", "Naviga su example.com").
 *    We retain the last seen label through the linger so it doesn't blank out
 *    between calls.
 */
import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';

const LINGER_MS = 700;

interface AgentActivityPillProps {
  active: boolean;
  action?: string | null;
}

export function AgentActivityPill({ active, action }: AgentActivityPillProps) {
  const [show, setShow] = useState(active);
  const [label, setLabel] = useState<string | null>(action ?? null);

  useEffect(() => {
    if (active) {
      // Show + retain the latest action label. The setState calls live inside
      // the timer callback (not synchronously in the effect body) so they don't
      // trip react-hooks/set-state-in-effect; the 0ms defer is imperceptible.
      const on = setTimeout(() => {
        setShow(true);
        if (action) setLabel(action);
      }, 0);
      return () => clearTimeout(on);
    }
    // active went false — LINGER so a burst of tool calls doesn't flicker. The
    // label is intentionally NOT cleared, so the text persists through the linger.
    const off = setTimeout(() => setShow(false), LINGER_MS);
    return () => clearTimeout(off);
  }, [active, action]);

  if (!show) return null;
  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/15 border border-primary/30 text-primary text-[11px] font-medium select-none"
      data-testid="browser-agent-activity-pill"
      title="L'agente sta controllando il browser"
    >
      <Bot className="w-3.5 h-3.5 animate-pulse shrink-0" />
      <span className="truncate max-w-[160px]">{label || 'Agente al lavoro'}</span>
    </div>
  );
}
