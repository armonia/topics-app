/**
 * The world the screens of this folder read: the example data and the words of
 * one organization. ORBIT is the default; an entry that runs another
 * organization calls `setWorld()` before it imports the app, so the constants
 * the modules compute when they load already read the right world.
 *
 * Everything the screens used to take from `fixtures/orbit-org/*` goes through
 * `world()` and the helpers below, so no screen names an organization.
 */
import type { OrgWorld } from '../../ui/fixtures/world-types';
import type { OrbitAgent, OrbitPersona, OrbitTeam } from '../../ui/fixtures/orbit-org/people';
import type { OrbitTown } from '../../ui/fixtures/orbit-org/data';
import type { KnowledgeCitation, KnowledgeDoc, KnowledgePart } from '../../ui/fixtures/orbit-org/knowledge';
import type { OrbitProgram } from '../../ui/fixtures/orbit-org/programs';
import { setOrgWords } from '../../ui/copy/org-words';

let current: OrgWorld | undefined;

/** The world the app runs on. */
export function world(): OrgWorld {
  if (!current) throw new Error('world(): no world chosen, call setWorld() before anything reads it');
  return current;
}

/** Chooses the world; call it before importing anything that reads it. */
export function setWorld(w: OrgWorld): void {
  current = w;
  setOrgWords(w.words);
}

export const personaById = (id: string): OrbitPersona | undefined => world().people.personas.find((p) => p.id === id);
export const agentById = (id: string): OrbitAgent | undefined => world().people.agents.find((a) => a.id === id);
export const teamById = (id: string): OrbitTeam | undefined => world().people.teams.find((t) => t.id === id);
export const programById = (id: string): OrbitProgram | undefined => world().programs.find((p) => p.id === id);
export const knowledgeDocById = (id: string): KnowledgeDoc | undefined => world().knowledge.docs.find((d) => d.id === id);
export const townById = (id: string): OrbitTown | undefined => world().towns.find((t) => t.id === id);

/** The team of a person: the people with the viewer role sit apart, every other person with their area. */
export function teamIdOfPerson(personaId: string): string | undefined {
  const p = personaById(personaId);
  if (!p) return undefined;
  return p.role === world().people.viewerRole ? world().people.viewerTeam : p.area;
}

/** The people of a team. */
export const teamMembers = (id: string): OrbitPersona[] => world().people.personas.filter((p) => teamIdOfPerson(p.id) === id);

/** The town a card's place belongs to: `Roma (AMA, Smart Leaf)` is Rome. */
export function townOfPlace(place: string | undefined): OrbitTown | undefined {
  if (!place) return undefined;
  return world().towns.find((t) => place === t.name || place.startsWith(`${t.place ?? t.name} (`) || place === t.place);
}

/** The parts that cite a card, a flow (or one of its steps) or a contract (or one of its clauses). */
export function partsCiting(kind: KnowledgeCitation['kind'], id: string, at?: string): Array<{ doc: KnowledgeDoc; part: KnowledgePart; citation: KnowledgeCitation }> {
  const out: Array<{ doc: KnowledgeDoc; part: KnowledgePart; citation: KnowledgeCitation }> = [];
  for (const doc of world().knowledge.docs) {
    for (const part of doc.parts) {
      for (const citation of part.citedBy ?? []) {
        if (citation.kind === kind && citation.id === id && (at === undefined || citation.at === at)) out.push({ doc, part, citation });
      }
    }
  }
  return out;
}

