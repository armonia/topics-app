/**
 * CHI ALTRO C'È, della tua organizzazione.
 *
 * La barra sopra la status bar diceva chi sei tu e quanti ferri hai. «Con chi
 * sto lavorando» non aveva risposta da nessuna parte — né lì, né col tasto
 * destro su un progetto — e il dato per darla esisteva già: `org_members`
 * popolata, e `lastSeenAt` per persona dalla rotta dei membri.
 *
 * LA SOGLIA STA QUI, non nel server, ed è una scelta. Il server manda i
 * millisecondi grezzi: se dichiarasse lui «online: true» congelerebbe una
 * finestra temporale che il client non può più cambiare, e due schermate con
 * due soglie diverse direbbero due verità sullo stesso membro.
 */

/** Visto negli ultimi cinque minuti = c'è. */
export const PRESENZA_MS = 5 * 60_000;

export interface MembroPresenza {
  id: string;
  lastSeenAt: number | null;
  /** Il nome dalla rotta dei membri. La rubrica puo' non averlo ancora. */
  name?: string | null;
}

/** Una faccia da mostrare: chi e', e con cosa lo si disegna. */
export interface FacciaPresenza {
  id: string;
  nome: string;
  avatarUrl: string | null;
  iniziali: string;
}

/** Quel poco della rubrica che serve per disegnare una faccia. */
export interface RigaRubrica {
  id: string;
  displayName: string;
  github?: { avatarUrl: string | null } | null;
}

/**
 * Quanti membri sono online ADESSO, escluso te.
 *
 * Te stesso non conti: sei la riga sopra, e sommarti direbbe «2 online» a chi è
 * da solo con la propria seconda macchina. È la differenza fra «chi altro c'è»
 * e «quante sessioni ci sono», e questa riga risponde alla prima.
 */
export function presentiOra(
  membri: readonly MembroPresenza[],
  io: string | null,
  adesso: number,
  sogliaMs: number = PRESENZA_MS,
): number {
  // NON SAPERE CHI SEI NON E' «SEI NESSUNO».
  //
  // Con `io` a null il filtro `m.id !== io` non esclude piu' niente, e chi e'
  // da solo si vede contare 1: se stesso, presentato come «chi altro c'e'». Il
  // caso non e' teorico — l'identita' arriva da `/api/people`, una fetch
  // separata da quella dei membri, e finche' non risponde (o se fallisce, che
  // il chiamante ingoia di proposito) `io` E' null mentre i membri ci sono gia'.
  //
  // Zero, quindi, e la riga non compare: «non lo so» si dice tacendo, non
  // sparando un numero che nel caso piu' comune - una persona sola - e' anche
  // quello sbagliato.
  if (io === null) return 0;
  // Un `lastSeenAt` nel FUTURO (orologi che non concordano fra due macchine)
  // conta come presente: è il verso giusto in cui sbagliare, perché l'errore
  // opposto nasconderebbe qualcuno che c'è davvero. La regola sta in `online`,
  // una sola volta: questa riga e le facce devono dire lo stesso di ogni membro.
  return membri.filter((m) => m.id !== io && online(m, adesso, sogliaMs)).length;
}

/**
 * Le FACCE di chi e' online, non solo quante sono.
 *
 * Un numero dice che c'e' qualcuno, una faccia dice CHI: e' la differenza fra
 * «2 online» e «ci sono queste due persone», ed e' l'unica delle due che
 * risparmia il clic per andare a vedere. La rubrica (`/api/people`) porta la
 * faccia, la rotta dei membri porta l'ultimo accesso: nessuna delle due da sola
 * basta, quindi si uniscono qui invece che in ciascuna riga che le disegna.
 *
 * L'ORDINE E' STABILE — chi si e' visto piu' di recente per primo, poi il nome.
 * Un elenco che si riordina a ogni giro di rete e' un elenco in cui non si
 * riconosce nessuno: le stesse due facce si scambiano di posto ogni minuto.
 */
export function facceOnline(
  membri: readonly MembroPresenza[],
  rubrica: readonly RigaRubrica[],
  io: string | null,
  adesso: number,
  sogliaMs: number = PRESENZA_MS,
): FacciaPresenza[] {
  // Stessa guardia di `presentiOra`, e per la stessa ragione: senza sapere chi
  // sei, la prima faccia dell'elenco saresti tu.
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
 * Le facce di piu' organizzazioni in un elenco solo, senza ripetizioni.
 *
 * Chi sta in due gruppi con te e' UNA persona, non due: la riga degli amici
 * risponde a «chi c'e'», e la stessa faccia due volte e' l'errore piu' visibile
 * che quella riga possa fare.
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

/** Visto entro la soglia. Un `lastSeenAt` nel futuro conta come presente. */
function online(m: MembroPresenza, adesso: number, sogliaMs: number): boolean {
  return m.lastSeenAt !== null
    && Number.isFinite(m.lastSeenAt)
    && adesso - (m.lastSeenAt as number) < sogliaMs;
}

/** Il nome: prima la rubrica, poi quello dei membri, poi niente. */
function nomeDi(m: MembroPresenza, perId: Map<string, RigaRubrica>): string {
  return (perId.get(m.id)?.displayName || m.name || '').trim();
}

/** Una o due iniziali. Vuoto quando il nome non c'e': chi disegna decide. */
function inizialiDi(nome: string): string {
  return nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}
