import type { ReactNode } from 'react';
import { Kanban, Users } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { PaneHeader } from '../shell/PaneHeader';
import { Avatar, Monogram } from '../shell/SidebarRows';
import { FOCUS_RING, pressable } from '../shell/pressable';
import type { Tone } from '../types';

export interface OrgPageCardModel {
  id: string;
  title: string;
  column: string;
  tone: Tone;
  onOpen: () => void;
}

export interface OrgMemberModel {
  id: string;
  name: string;
  monogram: string;
  color: string;
  role: string;
  onOpen: () => void;
}

const ROW = `flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-app-hover ${FOCUS_RING}`;

/**
 * The page of an organization that has no surfaces of its own in the preview:
 * who it is in a line, its cards on the Board (with the way to the Board
 * filtered on it), the people who belong to it, and whatever the container
 * adds (`children`: the flows it configures, or the way to start the first).
 */
export function OrgPage({ name, monogram, color, summary, cards, cardCount, onOpenBoard, members, copy, children }: {
  name: string;
  monogram: string;
  color: string;
  summary: string;
  cards: OrgPageCardModel[];
  cardCount: number;
  onOpenBoard: () => void;
  members: OrgMemberModel[];
  copy: UiCopy;
  children?: ReactNode;
}) {
  const o = copy.orgs.page;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: name }]} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
        <div className="mx-auto flex max-w-[960px] flex-col gap-4">
          <div className="flex items-center gap-3">
            <Monogram text={monogram} color={color} size={36} />
            <div className="min-w-0">
              <h1 className="truncate text-[20px] font-semibold leading-7 text-app-text">{name}</h1>
              <p className="text-prose leading-6 text-app-text-secondary">{summary}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card
              icon={Kanban}
              title={o.boardTitle(cardCount)}
              actions={<Button size="sm" onClick={onOpenBoard}>{o.openBoard}</Button>}
            >
              {cards.length === 0 ? (
                <p className="text-compact text-app-text-tertiary">{o.noCards}</p>
              ) : (
                <ul className="-mx-1.5 flex flex-col">
                  {cards.map((c) => (
                    <li key={c.id}>
                      <div {...pressable(c.onOpen)} role="button" className={ROW}>
                        <span className="min-w-0 flex-1 truncate text-prose text-app-text">{c.title}</span>
                        <Chip tone={c.tone}>{c.column}</Chip>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card icon={Users} title={o.members(members.length)}>
              <ul className="-mx-1.5 flex flex-col">
                {members.map((m) => (
                  <li key={m.id}>
                    <div {...pressable(m.onOpen)} role="button" className={ROW}>
                      <Avatar text={m.monogram} color={m.color} size={22} />
                      <span className="min-w-0 flex-1 truncate text-prose text-app-text">{m.name}</span>
                      <span className="shrink-0 text-compact text-app-text-tertiary">{m.role}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
