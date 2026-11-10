import { ArrowRight, Eye, FilePenLine, FileText, Plus } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { Select, Toggle } from '../primitives/Field';
import { KeyValue, PanelHeading, PanelSection, SidePanel } from '../primitives/Panel';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import type { ViewFactsModel, ViewStepToggle } from './model';

export interface WhereToggle {
  id: string;
  label: string;
  on: boolean;
  onToggle: Action;
}

/**
 * Where a view opens (a05): the steps of the flows that open it, each with a
 * switch, the roles that may open it, the devices and the way it opens, and
 * beside them what the view lets someone decide, the originals next to it and
 * what it writes in the record. The switches change the structure, so they are
 * disabled (with the reason) for whoever may not.
 */
export function ViewWhereScreen({ copy, name, description, facts, steps, roles, devices, opensAs, onOpensAs, add, onOpenView, onBack, backLabel, deniedTitle, phone, inUse }: {
  copy: UiCopy;
  name: string;
  description: string;
  facts: ViewFactsModel;
  steps: ViewStepToggle[];
  roles: WhereToggle[];
  devices: WhereToggle[];
  opensAs: { value: string; options: Array<{ value: string; label: string }>; disabled?: boolean };
  onOpensAs: (v: string) => void;
  /** The «add a step» form: the flow and step being picked, and the button. */
  add: {
    flow: string;
    flows: Array<{ value: string; label: string }>;
    onFlow: (v: string) => void;
    step: string;
    steps: Array<{ value: string; label: string }>;
    onStep: (v: string) => void;
    onAdd: Action;
  };
  onOpenView?: Action;
  onBack?: () => void;
  backLabel?: string;
  deniedTitle?: string;
  phone?: boolean;
  /** Whether the view is one of the organization's: the others are added first. */
  inUse: boolean;
}) {
  const w = copy.viewsMore.where;
  const on = steps.filter((s) => s.on).length;
  const main = (
    <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-6">
      <div>
        <h1 className="text-title font-semibold leading-7 text-app-text">{name}</h1>
        <p className="mt-0.5 text-prose leading-5 text-app-text-secondary">{description}</p>
      </div>
      {!inUse && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-compact text-app-text">{w.notAdopted}</p>}
      <Card title={w.stepsTitle} icon={FilePenLine} actions={<Chip tone={on ? 'green' : 'neutral'}>{w.stepsOn(on, steps.length)}</Chip>}>
        <p className="mb-2 text-compact text-app-text-tertiary">{w.stepsHint}</p>
        {steps.length === 0 ? (
          <p className="py-2 text-compact text-app-text-tertiary">{w.noSteps}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-app-border">
            {steps.map((s) => (
              <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-prose font-medium text-app-text">{s.step}</div>
                  <div className="truncate text-compact text-app-text-tertiary">{s.flow}</div>
                </div>
                {s.onOpen && <Button size="sm" variant="ghost" icon={ArrowRight} onClick={s.onOpen}>{w.openStep}</Button>}
                <Toggle checked={s.on} onChange={() => s.onToggle && s.onToggle()} disabled={s.onToggle === false} title={s.onToggle === false ? deniedTitle : w.toggleStep(s.step)} />
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-col gap-2 border-t border-app-border pt-3">
          <div className="text-mini font-medium text-app-text-secondary">{w.addStep}</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Select label={w.flow} value={add.flow} options={add.flows} onChange={add.onFlow} disabled={add.onAdd === false} title={add.onAdd === false ? deniedTitle : undefined} />
            <Select label={w.step} value={add.step} options={add.steps} onChange={add.onStep} disabled={add.onAdd === false} title={add.onAdd === false ? deniedTitle : undefined} />
            <Button icon={Plus} onClick={add.onAdd} title={add.onAdd === false ? deniedTitle : undefined}>{w.add}</Button>
          </div>
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title={w.rolesTitle}>
          <p className="mb-2 text-compact text-app-text-tertiary">{w.rolesHint}</p>
          <div className="flex flex-col gap-1">
            {roles.map((r) => (
              <Toggle key={r.id} label={r.label} checked={r.on} onChange={() => r.onToggle && r.onToggle()} disabled={r.onToggle === false} title={r.onToggle === false ? deniedTitle : undefined} />
            ))}
          </div>
        </Card>
        <Card title={w.deviceTitle}>
          <p className="mb-2 text-compact text-app-text-tertiary">{w.deviceHint}</p>
          <div className="flex flex-col gap-1">
            {devices.map((d) => (
              <Toggle key={d.id} label={d.label} checked={d.on} onChange={() => d.onToggle && d.onToggle()} disabled={d.onToggle === false} title={d.onToggle === false ? deniedTitle : undefined} />
            ))}
          </div>
          <div className="mt-3">
            <Select label={w.opensAs} value={opensAs.value} options={opensAs.options} onChange={onOpensAs} disabled={opensAs.disabled} title={opensAs.disabled ? deniedTitle : undefined} />
          </div>
        </Card>
      </div>
    </div>
  );
  const side = (
    <>
      <PanelHeading tag={w.factsTag} tagIcon={Eye} title={w.factsTitle}>{w.factsBody}</PanelHeading>
      <PanelSection label={w.decision}><p className="text-prose leading-6 text-app-text">{facts.decision ?? w.none}</p></PanelSection>
      <PanelSection label={w.originals}>
        <KeyValue lead={<FileText size={14} className="text-app-text-tertiary" aria-hidden="true" />} label={facts.originals ?? w.none} value="" />
      </PanelSection>
      <PanelSection label={w.writes}><p className="text-prose leading-6 text-app-text">{facts.writes ?? w.writesNothing}</p></PanelSection>
      <PanelSection label={w.base}><p className="text-prose leading-6 text-app-text">{facts.base ?? w.none}</p></PanelSection>
      <PanelSection label={w.principles}>
        <ul className="flex flex-col gap-2.5 text-compact leading-5 text-app-text-secondary">
          <li><span className="font-medium text-app-text">{w.principle1.title}</span> {w.principle1.body}</li>
          <li><span className="font-medium text-app-text">{w.principle2.title}</span> {w.principle2.body}</li>
          <li><span className="font-medium text-app-text">{w.principle3.title}</span> {w.principle3.body}</li>
        </ul>
      </PanelSection>
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        crumbs={[{ label: copy.views.root }, { label: name, detail: w.crumb }]}
        leading={onBack && backLabel ? <BackButton label={backLabel} onClick={onBack} copy={copy} /> : undefined}
      >
        <Button variant="primary" icon={ArrowRight} onClick={onOpenView}>{w.openView}</Button>
      </PaneHeader>
      {phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {main}
          <div className="border-t border-app-border bg-surface">{side}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto">{main}</div>
          <SidePanel width={360}>{side}</SidePanel>
        </div>
      )}
    </div>
  );
}
