/**
 * THE MCP TOOLS, where the agent that uses them is asked: a row of the
 * composer's «+» (SETHOME-01).
 *
 * The tail says how many servers answer («3 attivi», «Spenti»), read with the
 * PEEK route when the «+» opens: opening a composer, or this menu, never mounts
 * the fleet (`/api/mcp/fleet?peek=1`). The row opens the tools panel hung from
 * the «+» itself, through the one host of these forms (`openHome`).
 */
import { useEffect, useState, type RefObject } from 'react';
import { Plug } from 'lucide-react';
import { mcpApi, type McpFleetStatus } from '../../lib/api';
import { openHome } from '../../lib/openHome';
import { toolsTail } from '../Sidebar/formLevelTails';
import { useT } from '../../hooks/useT';

export function ComposerToolsRow({ triggerRef, rowClass, onPicked }: {
  /** The «+»: the panel hangs from it once the menu is gone. */
  triggerRef: RefObject<HTMLElement | null>;
  rowClass: string;
  /** Closes the «+» menu. */
  onPicked: () => void;
}) {
  const tr = useT();
  const [fleet, setFleet] = useState<McpFleetStatus | null>(null);
  // The row is mounted only while the «+» is open: mounting IS opening.
  useEffect(() => {
    const ctrl = new AbortController();
    mcpApi.peek(ctrl.signal)
      .then((f) => { if (!ctrl.signal.aborted) setFleet(f); })
      .catch(() => { /* a fact not read is a tail not shown, never a made-up one */ });
    return () => ctrl.abort();
  }, []);
  const tail = toolsTail(fleet, tr);
  return (
    <button
      type="button"
      onClick={() => { const el = triggerRef.current; onPicked(); openHome('tools', el); }}
      className={`${rowClass} text-app-text`}
      data-testid="composer-tools"
    >
      <Plug size={14} />
      <span className="min-w-0 flex-1 truncate">{tr('home.toolsRow')}</span>
      {tail && <span data-testid="composer-tools-tail" className="ml-auto text-mini tabular-nums text-app-text-muted">{tail}</span>}
    </button>
  );
}
