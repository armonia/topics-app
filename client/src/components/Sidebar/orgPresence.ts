/**
 * WHO ELSE IS AROUND, in your organisation.
 *
 * The bar above the status bar said who you are and how many machines you own.
 * "Who am I working with" had no answer anywhere: not there, and not from the
 * right click on a project. Yet the data to answer it already existed, with
 * `org_members` populated and a per person `lastSeenAt` on the members route.
 *
 * THE THRESHOLD LIVES HERE, not on the server, and that is a decision. The
 * server sends raw milliseconds: were it to declare "online: true" itself, it
 * would freeze a time window the client can no longer change, and two screens
 * with two different thresholds would tell two truths about the same member.
 */

/** Seen within the last five minutes means present. */
export const PRESENZA_MS = 5 * 60_000;

export interface MembroPresenza {
  id: string;
  lastSeenAt: number | null;
  /** The name from the members route. The address book may not have it yet. */
  name?: string | null;
}

/** A face to show: who it is, and what to draw it with. */
export interface FacciaPresenza {
  id: string;
  nome: string;
  avatarUrl: string | null;
  iniziali: string;
}

/**
 * One person in the OPEN list: the face, plus whether they are here right now
 * and how long they have been away. The closed chip only shows `FacciaPresenza`
 * because everyone in it is online by construction; here absence is itself a
 * fact worth showing.
 */
export interface RigaPresenza extends FacciaPresenza {
  presente: boolean;
  /** Last seen, used both to sort and to say "two hours ago". */
  vistoA: number | null;
}

/** The little the address book has to give to draw one face. */
export interface RigaRubrica {
  id: string;
  displayName: string;
  github?: { avatarUrl: string | null } | null;
}

/**
 * How many members are online RIGHT NOW, you excluded.
 *
 * You do not count yourself: you are the row above, and adding yourself in
 * would say "2 online" to someone sitting alone with their own second machine.
 * That is the difference between "who else is here" and "how many sessions are
 * open", and this row answers the first question.
 */
export function presentiOra(
  membri: readonly MembroPresenza[],
  io: string | null,
  adesso: number,
  sogliaMs: number = PRESENZA_MS,
): number {
  // NOT KNOWING WHO YOU ARE IS NOT THE SAME AS "YOU ARE NOBODY".
  //
  // With `io` null the `m.id !== io` filter stops excluding anything, and a
  // person working alone watches themselves be counted as 1, presented as "who
  // else is here". The case is not theoretical: identity comes from
  // `/api/people`, a fetch separate from the one for the members, and until it
  // answers (or if it fails, which the caller swallows on purpose) `io` IS null
  // while the members are already there.
  //
  // Zero, then, and the row does not appear: "I do not know" is said by keeping
  // quiet, not by firing off a number that in the commonest case, one person on
  // their own, also happens to be the wrong one.
  if (io === null) return 0;
  // A `lastSeenAt` in the FUTURE (clocks that disagree between two machines)
  // counts as present: that is the right direction to be wrong in, because the
  // opposite mistake would hide somebody who really is here. The rule lives in
  // `online`, once: this count and the faces must say the same about a member.
  return membri.filter((m) => m.id !== io && online(m, adesso, sogliaMs)).length;
}

/**
 * The FACES of whoever is online, not just how many they are.
 *
 * A number says somebody is there, a face says WHO: that is the difference
 * between "2 online" and "these two people are here", and only the second one
 * saves the click it takes to go and look. The address book (`/api/people`)
 * carries the face, the members route carries the last access: neither is
 * enough on its own, so they are joined here instead of in every row that
 * draws them.
 *
 * THE ORDER IS STABLE: most recently seen first, then the name. A list that
 * reshuffles on every network round trip is a list in which nobody is
 * recognisable, with the same two faces swapping places every minute.
 */
export function facceOnline(
  membri: readonly MembroPresenza[],
  rubrica: readonly RigaRubrica[],
  io: string | null,
  adesso: number,
  sogliaMs: number = PRESENZA_MS,
): FacciaPresenza[] {
  // The same guard as `presentiOra`, and for the same reason: without knowing
  // who you are, the first face in the list would be your own.
  if (io === null) return [];
  const perId = new Map(rubrica.map((p) => [p.id, p]));
  return membri
    .filter((m) => m.id !== io && online(m, adesso, sogliaMs))
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || nomeDi(a, perId).localeCompare(nomeDi(b, perId)))
    .map((m) => {
      const p = perId.get(m.id);
      const nome = nomeDi(m, perId);
      return {
        id: m.id,
        nome,
        avatarUrl: p?.github?.avatarUrl ?? null,
        iniziali: inizialiDi(nome),
      };
    });
}

/**
 * EVERYONE, not just who is here: the list the dropdown opens onto.
 *
 * The closed row shows who is online, because inside a 240px strip the space
 * goes to the answer. The open panel, on the other hand, is where you go to
 * look somebody up, and the person you are looking for is offline right now
 * exactly half of the time: a list that shows only the present forces you into
 * the organisation settings just to learn whether a person exists at all.
 *
 * PRESENT FIRST, and inside both groups the same order as `facceOnline`: most
 * recently seen, then the name. That way the open list and the closed row of
 * faces tell the same story in the same order, and the first four faces on the
 * chip are the first four rows of the panel.
 */
export function gentePresenza(
  membri: readonly MembroPresenza[],
  rubrica: readonly RigaRubrica[],
  io: string | null,
  adesso: number,
  sogliaMs: number = PRESENZA_MS,
): RigaPresenza[] {
  // Same guard as its siblings: not knowing who you are puts you in your list.
  if (io === null) return [];
  const perId = new Map(rubrica.map((p) => [p.id, p]));
  return membri
    .filter((m) => m.id !== io)
    .map((m) => {
      const p = perId.get(m.id);
      const nome = nomeDi(m, perId);
      return {
        id: m.id,
        nome,
        avatarUrl: p?.github?.avatarUrl ?? null,
        iniziali: inizialiDi(nome),
        presente: online(m, adesso, sogliaMs),
        vistoA: m.lastSeenAt ?? null,
      };
    })
    .sort((a, b) => Number(b.presente) - Number(a.presente)
      || (b.vistoA ?? 0) - (a.vistoA ?? 0)
      || a.nome.localeCompare(b.nome));
}

/**
 * The people of several organisations in a single list, with no repeats.
 *
 * Like `unisciFacce`, except that here the same person can arrive twice in two
 * different states (online in group A because that server saw them a minute
 * ago, offline in group B which has not seen them since yesterday): the PRESENT
 * copy wins. Saying "offline" about somebody who is typing is the worse of the
 * two mistakes, because it is the one that makes people stop writing to them.
 */
export function unisciGente(gruppi: readonly RigaPresenza[][]): RigaPresenza[] {
  const perId = new Map<string, RigaPresenza>();
  for (const gruppo of gruppi) {
    for (const r of gruppo) {
      const gia = perId.get(r.id);
      if (!gia || (r.presente && !gia.presente) || (r.vistoA ?? 0) > (gia.vistoA ?? 0)) perId.set(r.id, r);
    }
  }
  return [...perId.values()].sort((a, b) => Number(b.presente) - Number(a.presente)
    || (b.vistoA ?? 0) - (a.vistoA ?? 0)
    || a.nome.localeCompare(b.nome));
}

/**
 * The faces of several organisations in a single list, with no repeats.
 *
 * Someone who shares two groups with you is ONE person, not two: the friends
 * row answers "who is here", and the same face showing twice is the most
 * visible mistake that row can possibly make.
 */
export function unisciFacce(gruppi: readonly FacciaPresenza[][]): FacciaPresenza[] {
  const visti = new Set<string>();
  const out: FacciaPresenza[] = [];
  for (const gruppo of gruppi) {
    for (const f of gruppo) {
      if (visti.has(f.id)) continue;
      visti.add(f.id);
      out.push(f);
    }
  }
  return out;
}

/** Seen within the threshold. A `lastSeenAt` in the future counts as present. */
function online(m: MembroPresenza, adesso: number, sogliaMs: number): boolean {
  return m.lastSeenAt !== null
    && Number.isFinite(m.lastSeenAt)
    && adesso - (m.lastSeenAt as number) < sogliaMs;
}

/** The name: the address book first, then the members route, then nothing. */
function nomeDi(m: MembroPresenza, perId: Map<string, RigaRubrica>): string {
  return (perId.get(m.id)?.displayName || m.name || '').trim();
}

/** One or two initials. Empty when there is no name: the drawing side decides. */
function inizialiDi(nome: string): string {
  return nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}
