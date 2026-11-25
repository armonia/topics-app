/**
 * Settings · Organization: the real facts of S.A.R.I.M. SRL, each with the
 * public page it comes from (the exact words in the tooltip of the link): who
 * it is, the counters of the home page, the certifications with their expiry,
 * the towns served, and the teams with their people in Topics.
 */
import type { ReactNode } from 'react';
import { BadgeCheck, MapPin, Users } from 'lucide-react';
import clsx from 'clsx';
import { world } from '../../world';
import type { OrbitArea } from '../../../../ui/fixtures/orbit-org/people';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { Block } from '../../../../ui/settings/Block';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import type { ScreenCtx } from '../../../app/kit';
import { ActorChip, SourceLink, StatTile } from '../../admin-parts';
import { dayLabel, daysTo } from '../../model/contracts';
import { SP } from '../../paths';
import { SettingsFrame } from './frame';

export function OrganizationPage({ ctx }: { ctx: ScreenCtx }) {
  const o = ctx.copy.orbitAdmin.settings.organization;
  /* The same rows as «Dati» > «Comuni serviti», without the past services. (allow-italian: quotes the Italian interface) */
  const served = world().towns.filter((t) => !t.past);
  /* The row of a town whose client is another body (ORBIT's Rome, for AMA) is not counted among the towns. */
  const towns = served.filter((t) => t.id !== world().organization.clientTown);
  const townPath = (id: string) => SP.dataRow('comuni', id); // allow-italian: address segment, not shown
  const seesData = ctx.can('view:data');
  const areas = Object.keys(world().people.areaLabel) as OrbitArea[];
  /* The source of a block sits beside its title; on a phone it goes under the description, which would otherwise shrink to a narrow column. */
  const sourced = (description: string, source: ReactNode) =>
    ctx.phone
      ? { description: <>{description}<span className="mt-1.5 flex">{source}</span></> }
      : { description, actions: source };

  return (
    <SettingsFrame ctx={ctx} section="organizzazione">
      <div className="flex flex-col gap-4">
        <Block title={o.identityTitle}>
          <dl className="flex flex-col">
            {world().organization.identity.map((f) => (
              <div key={f.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-app-border py-2 first:border-t-0 first:pt-0 last:pb-0">
                <dt className="w-[190px] shrink-0 text-prose text-app-text-secondary">{f.label}</dt>
                <dd className="min-w-[180px] flex-1 text-prose leading-5 text-app-text [overflow-wrap:anywhere]">{f.value}</dd>
                <dd className="shrink-0"><SourceLink ctx={ctx} label={f.source.label} url={f.source.url} title={o.sourceTitle(f.source.quote)} /></dd>
              </div>
            ))}
          </dl>
        </Block>

        <Block
          title={o.numbersTitle}
          {...sourced(o.numbersBody, <SourceLink ctx={ctx} label={world().organization.numbersSource.label} url={world().organization.numbersSource.url} title={o.sourceTitle(world().organization.numbersSource.quote)} />)}
        >
          {/* A figure longer than half a phone (the kilograms) takes the whole row there instead of spilling out of its card. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {world().organization.numbers.map((n) => <StatTile key={n.id} label={n.label} value={n.value} className={n.value.length > 7 ? 'col-span-2 md:col-span-1' : undefined} />)}
          </div>
        </Block>

        {/* An organization that publishes no certification has no block for them. */}
        {world().organization.certifications.length > 0 && (
          <Block
            title={o.certificationsTitle}
            {...sourced(o.certificationsBody, <SourceLink ctx={ctx} label={world().organization.certificationsSource.label} url={world().organization.certificationsSource.url} title={o.sourceTitle(world().organization.certificationsSource.quote)} />)}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {world().organization.certifications.map((c) => {
                const days = c.expires ? daysTo(c.expires) : undefined;
                return (
                  <div key={c.id} className="flex min-w-0 items-start gap-2.5 rounded-lg border border-app-border px-3 py-2.5">
                    <BadgeCheck size={15} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="text-prose font-medium leading-5 text-app-text">{c.name}</div>
                      <p className="text-mini leading-4 text-app-text-tertiary">{c.what}</p>
                      {c.expires && days !== undefined && (
                        <Chip className="mt-1.5" tone={days < 0 ? 'red' : days <= 90 ? 'amber' : 'neutral'}>{o.expires(dayLabel(c.expires), days)}</Chip>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Block>
        )}

        <Block
          title={o.servedTitle(towns.length)}
          {...sourced(o.servedBody, <SourceLink ctx={ctx} label={world().organization.servedSource.label} url={world().organization.servedSource.url} title={o.sourceTitle(world().organization.servedSource.quote)} />)}
        >
          <ul className="grid gap-x-4 sm:grid-cols-2">
            {served.map((t) => (
              <li key={t.id} className="flex min-w-0 items-center gap-2 border-t border-app-border py-1.5">
                <MapPin size={13} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                <button
                  type="button"
                  data-tip={seesData ? o.servedOpen(t.name) : ctx.deniedTitle('view:data')}
                  disabled={!seesData}
                  onClick={() => ctx.go(townPath(t.id))}
                  className={clsx('min-w-0 flex-1 rounded-md px-1 py-0.5 text-left hover:bg-app-hover disabled:cursor-default disabled:hover:bg-transparent', FOCUS_RING)}
                >
                  <span className="text-prose text-app-text">{t.name} ({t.province})</span>
                  <span className="block text-mini leading-4 text-app-text-tertiary">{t.since}</span>
                </button>
                <SourceLink ctx={ctx} label={t.source.host} url={t.source.url} />
              </li>
            ))}
          </ul>
        </Block>

        <Block
          title={o.teamsTitle}
          actions={<Button size="sm" icon={Users} onClick={ctx.allow('view:team', () => ctx.go(SP.team()))} title={ctx.deniedTitle('view:team')}>{o.openTeam}</Button>}
        >
          <div className="flex flex-col">
            {areas.map((a) => {
              const people = world().people.personas.filter((p) => p.area === a);
              return (
                <div key={a} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-app-border py-2 first:border-t-0 first:pt-0 last:pb-0">
                  <div className="min-w-[200px] flex-1">
                    <div className="text-prose leading-5 text-app-text">{world().people.areaLabel[a]}</div>
                    <p className="text-mini leading-4 text-app-text-tertiary">{o.areaPeople(people.length)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {people.map((p) => <ActorChip key={p.id} id={p.id} ctx={ctx} />)}
                  </div>
                </div>
              );
            })}
          </div>
        </Block>
      </div>
    </SettingsFrame>
  );
}
