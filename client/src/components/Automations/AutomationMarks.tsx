/**
 * The small marks of an automation row, shared by the table, «Decidi tu» and
 * the detail: the project's icon (the hub's, through the bridge), the brand
 * of who answers (Claude, Codex, Muse) and of where it delivers, and the
 * row's steps in short with the inline list they open into.
 */
import { FileStack, MessageCircle, Sparkles, Terminal } from 'lucide-react';
import { ClaudeIcon } from '../Shared/ClaudeIcon';
import { CodexIcon } from '../Shared/CodexIcon';
import { serverHttpBase } from '../../lib/shell/net';
import type { AutomationRow, FlowNode } from '../../lib/automations';

/** The hub's icon path (`/api/project-icon?name=`) through the Topics bridge (`/api/hub/…`). */
function bridged(icon: string): string | null {
  return icon.startsWith('/api/') ? `${serverHttpBase()}/api/hub/${icon.slice('/api/'.length)}` : null;
}

export function ProjectMark({ project }: { project: AutomationRow['project'] }) {
  const src = project?.icon ? bridged(project.icon) : null;
  if (!project || !src) return null;
  return (
    <img
      src={src}
      alt=""
      title={project.name}
      loading="lazy"
      width={14}
      height={14}
      className="h-3.5 w-3.5 flex-none rounded-[3px] object-contain"
      data-testid="automation-project"
      data-project={project.name}
      onError={(e) => { e.currentTarget.style.display = 'none'; }}
    />
  );
}

/** A brand's mark; the generic glyph of the step's kind when the brand has none here. */
export function BrandMark({ brand, kind, size = 12 }: { brand: string | null; kind?: FlowNode['kind']; size?: number }) {
  if (brand === 'claude') return <ClaudeIcon size={size} className="text-[#d97757]" />;
  if (brand === 'codex') return <CodexIcon size={size} />;
  if (brand === 'muse') return <Sparkles size={size} className="text-violet-500 dark:text-violet-400" aria-hidden="true" />;
  if (brand === 'whatsapp' || brand === 'discord' || brand === 'telegram' || kind === 'deliver') return <MessageCircle size={size} aria-hidden="true" />;
  if (kind === 'sources') return <FileStack size={size} aria-hidden="true" />;
  if (kind === 'model') return <Sparkles size={size} aria-hidden="true" />;
  return <Terminal size={size} aria-hidden="true" />;
}

/** The row's steps, open: each with its mark, the model step as the queue of who may answer. */
export function FlowSteps({ row, label }: { row: AutomationRow; label: string }) {
  if (!row.flow) return null;
  return (
    <ol aria-label={label} className="col-span-full m-0 mb-1 flex list-none flex-wrap items-center gap-1 p-0 text-mini text-app-text-secondary" data-testid="automation-flow-steps">
      {row.flow.nodes.map((n, i) => (
        <li key={i} className="inline-flex items-center gap-1 rounded-sm border border-app-border-subtle bg-app-inset px-1.5 py-0.5" data-kind={n.kind}>
          {n.kind === 'model' && n.who.some((w) => w.brand)
            ? n.who.map((w, j) => (
              <span key={w.name} className="inline-flex items-center gap-1">
                {j > 0 && <span aria-hidden="true" className="text-app-text-faint">›</span>}
                <BrandMark brand={w.brand} kind="model" />{w.name}
              </span>
            ))
            : <><BrandMark brand={n.brand} kind={n.kind} />{n.label}</>}
        </li>
      ))}
    </ol>
  );
}
