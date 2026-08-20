/**
 * IL BLOCCO DELL'IDENTITA', in fondo alla colonna: tre righe, tre domande.
 *
 *   1. IO         chi sono, su cosa sto, e cosa sta lavorando adesso
 *   2. ORG        con chi sto: un chip per organizzazione, con chi c'e' dentro
 *   3. AMICI      chi ho intorno: le facce di chi e' online adesso
 *
 * ── PERCHE' TRE RIGHE E NON DUE (O CINQUE) ──────────────────────────────────
 * Prima erano due, e nessuna delle due era una domanda: una riga diceva il
 * riepilogo del lavoro («3 al lavoro · 12 aperte») e l'altra impilava nella
 * stessa striscia chi sei, il tuo ferro, il logo dell'organizzazione, quanti
 * colleghi c'erano e quanti dispositivi hai. Cinque cose diverse allineate a
 * destra a contendersi ~240px, che si legge come un elenco di badge e non come
 * una gerarchia: per sapere «chi c'e' della mia organizzazione» bisognava
 * decifrare un numero accanto a un logo, e gli amici non c'erano proprio.
 *
 * Adesso ogni riga ha UN soggetto, e il soggetto e' il primo glifo a sinistra:
 * la tua faccia, i loghi dei gruppi, le facce degli altri. Tutto cio' che ti
 * riguarda sta sulla PRIMA riga (faccia, nome, ferro, dispositivi, lavoro in
 * corso), perche' erano gia' la stessa cosa detta in due strisce.
 *
 * ── OGNI RIGA E' UNA PORTA ──────────────────────────────────────────────────
 * Una riga che mostra un dato e non porta dove quel dato si governa costringe a
 * cercare la stessa cosa nelle impostazioni. Qui la prima riga apre il tuo
 * profilo, i chip aprono la gestione delle organizzazioni, gli amici aprono la
 * pagina degli amici: sono le tre pagine del pane «Profilo», cioe' esattamente
 * i tre soggetti delle tre righe.
 *
 * ── QUANDO NON C'E' NIENTE DA DIRE, NON DICE NIENTE ─────────────────────────
 * Senza organizzazioni la seconda riga non esiste; senza altre persone la terza
 * nemmeno. Un'installazione locale resta con la sola riga dell'identita', com'era
 * prima. Una riga che compare sempre e dice «0» e' una riga che si impara a
 * saltare, e quando poi ha qualcosa da dire nessuno la guarda piu'.
 */
import { useCallback, useEffect, useState } from 'react';
import { Building2, Monitor, Smartphone, Users } from 'lucide-react';
import { subscribeSession, type SessionState } from '@/lib/auth/session';
import { etichettaIdentita } from './identityLabel';
import { useIdentityPresence, type OrgConPresenza } from '@/hooks/useIdentityPresence';
import { usePresenceSummary } from '@/hooks/usePresenceSummary';
import { apriProfilo } from '@/state/profileTarget';
import type { FacciaPresenza } from './orgPresence';
import { ROW_INSET, SIDEBAR_HOVER } from '@/lib/selectionStyles';
import { PALLINO_OK, SEGNALE_OK } from './chromeSignals';
import { useT } from '@/hooks/useT';

/** Le tre righe hanno la stessa misura: sono una fascia sola, e una riga che si
 *  impagina per conto suo si legge come un pezzo incollato in fondo. */
const RIGA = 'flex w-full items-center gap-1.5 border-t border-app-border text-[11px] min-h-6 max-md:min-h-9';

/** Quante facce si mostrano prima di passare al numero. Oltre quattro sono
 *  puntini indistinguibili larghi quanto la parola che li conterebbe. */
const MAX_FACCE = 4;

export function IdentityBlock({ onOpenDevices }: { onOpenDevices?: () => void }) {
  const presenza = useIdentityPresence();
  return (
    <>
      <RigaIo presenza={presenza} onOpenDevices={onOpenDevices} />
      <RigaOrganizzazioni orgs={presenza.orgs} />
      <RigaAmici online={presenza.amiciOnline} totali={presenza.amiciTotali} />
    </>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 1. IO
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * TUTTO CIO' CHE MI RIGUARDA, su una linea sola.
 *
 * La faccia e il nome sono il soggetto; il ferro e' il dettaglio (resta perche'
 * «ho appena appaiato il telefono, e' andata?» e' ancora una domanda vera, e
 * questa e' l'unica riga che la conferma); il lavoro in corso e i dispositivi
 * connessi chiudono a destra.
 *
 * IL FERRO CEDE IL POSTO AL LAVORO. A 240px la frase del riepilogo («3 al
 * lavoro · 12 aperte») e il nome del ferro non ci stanno insieme, e fra le due
 * vince quella che cambia: il nome del ferro e' lo stesso da quando hai
 * appaiato, il riepilogo dice cosa sta succedendo adesso. Quando non c'e'
 * niente da riassumere il ferro torna scritto per esteso, e non e' un
 * compromesso: e' esattamente il momento in cui c'e' spazio.
 */
function RigaIo({ presenza, onOpenDevices }: {
  presenza: ReturnType<typeof useIdentityPresence>;
  onOpenDevices?: () => void;
}) {
  const tr = useT();
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [ferri, setFerri] = useState<{ connessi: number; totali: number } | null>(null);
  const { summary } = usePresenceSummary();
  useEffect(() => subscribeSession(setSession), []);

  const chi = etichettaIdentita(presenza.io, session);

  // Quanti dispositivi ci sono, e quanti sono vivi adesso: e' cio' che rende la
  // riga una RISPOSTA e non un'etichetta. «Questo computer» da solo non dice
  // niente che non si sappia gia' stando seduti davanti.
  const caricaFerri = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/devices', { credentials: 'same-origin' });
      if (!r.ok) return;
      const b = await r.json() as { devices: Array<{ connected: boolean; revokedAt: number | null }> };
      const vivi = (b.devices ?? []).filter((d) => d.revokedAt === null);
      setFerri({ connessi: vivi.filter((d) => d.connected).length, totali: vivi.length });
    } catch { /* transitorio: la riga resta senza conteggio invece di mentire */ }
  }, []);

  useEffect(() => {
    const chiedi = () => { void caricaFerri(); };
    // Dopo il primo paint: il numero dei ferri non serve a nessuno nel primo
    // frame, e una scrittura di stato sincrona in montaggio e' cio' che
    // `set-state-in-effect` marca.
    const primo = setTimeout(chiedi, 0);
    window.addEventListener('topics:auth-pair-resolved', chiedi);
    window.addEventListener('topics:auth-device-revoked', chiedi);
    return () => {
      clearTimeout(primo);
      window.removeEventListener('topics:auth-pair-resolved', chiedi);
      window.removeEventListener('topics:auth-device-revoked', chiedi);
    };
  }, [caricaFerri]);

  if (session.status !== 'paired') return null;
  const locale = session.as === 'loopback';
  const Ferro = locale ? Monitor : Smartphone;

  return (
    <div
      data-testid="identity-row-me"
      className={RIGA}
      style={{ paddingInline: ROW_INSET }}
    >
      {/* LA PORTA DEL PROFILO e' il nome, non un'icona in fondo: il bersaglio e'
          tutta la parte sinistra della riga, che e' anche la piu' larga. */}
      <button
        data-testid="identity-me-profile"
        onClick={() => apriProfilo('profile')}
        className={`-mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left ${SIDEBAR_HOVER}`}
        // Il tooltip dice tutto quello che la riga puo' troncare, sempre: chi,
        // su cosa, cosa sta lavorando (e da dove viene quel conteggio: senza,
        // «12 aperte» sembra un numero inventato dalla barra), e dove porta il
        // clic.
        title={[
          `${chi.nome}${chi.dettaglio ? ` \u00b7 ${chi.dettaglio}` : ''}`,
          summary ?? '',
          summary ? tr('statusBar.presenceTitle') : '',
          tr('statusBar.me.openProfile'),
        ].filter(Boolean).join('\n')}
        aria-label={tr('statusBar.me.openProfile')}
      >
        {/* LA FACCIA, e solo quando c'e' una persona: un tondino con dentro
            l'iniziale di «Questo computer» sarebbe un avatar finto. */}
        {chi.personale
          ? (chi.avatarUrl
              ? <img src={chi.avatarUrl} alt="" className="h-4 w-4 flex-shrink-0 rounded-full object-cover" />
              : <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[8px] font-semibold leading-none text-white">{chi.iniziali}</span>)
          : <Ferro size={10} className="flex-shrink-0 text-app-text-secondary" />}
        <span className="truncate text-app-text">{chi.nome}</span>
        {/* IL FERRO. Per esteso quando c'e' spazio, ridotto al glifo quando il
            riepilogo del lavoro occupa la destra: il nome per esteso resta nel
            tooltip, che non tronca mai. */}
        {chi.dettaglio && (
          summary
            ? <Ferro size={10} className="flex-shrink-0 text-app-text-muted" />
            : (
              <span className="flex min-w-0 items-center gap-1 text-app-text-muted">
                <Ferro size={10} className="flex-shrink-0" />
                <span className="truncate">{chi.dettaglio}</span>
              </span>
            )
        )}
        {/* IL LAVORO IN CORSO, con le stesse parole che Topics pubblica sulla
            presence: «3 al lavoro · 12 aperte». Era una riga a se' e diceva di
            me quanto le altre, quindi e' rientrata qui. */}
        {summary && (
          <span
            data-testid="presence-summary"
            className="ml-auto flex min-w-0 items-center gap-1 text-app-text-secondary"
          >
            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${PALLINO_OK} animate-pulse`} />
            <span className="truncate">{summary}</span>
          </span>
        )}
      </button>
      {/* I DISPOSITIVI restano una porta a parte: «chi sono» e «quante macchine
          ho autorizzato» sono due domande, e la seconda si governa altrove. */}
      {ferri && ferri.totali > 0 && (
        <button
          data-testid="identity-me-devices"
          onClick={onOpenDevices}
          disabled={!onOpenDevices}
          className={`flex flex-shrink-0 items-center gap-1 rounded px-1 py-0.5 text-app-text-muted tabular-nums ${SIDEBAR_HOVER} disabled:hover:bg-transparent`}
          title={tr('statusBar.devicesTitle')}
          aria-label={tr('statusBar.devicesTitle')}
        >
          <Ferro size={10} className="flex-shrink-0" />
          {ferri.connessi > 0 ? `${ferri.connessi}/${ferri.totali}` : `${ferri.totali}`}
        </button>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 2. ORGANIZZAZIONI
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * UN CHIP PER GRUPPO, e dentro ogni chip chi c'e'.
 *
 * La presenza sta DENTRO il chip e non in un conteggio unico in fondo alla
 * riga: con due organizzazioni «3 online» non dice di quale gruppo sono, ed e'
 * la prima cosa che si vuole sapere. Le facce prima del numero, perche' «chi»
 * batte «quanti» e la faccia si riconosce senza leggere.
 *
 * La riga scorre in orizzontale invece di andare a capo: la fascia in fondo
 * alla colonna ha un'altezza fissa, e un blocco che cresce di una riga ogni due
 * gruppi mangerebbe l'elenco dei topic.
 */
function RigaOrganizzazioni({ orgs }: { orgs: OrgConPresenza[] }) {
  const tr = useT();
  if (orgs.length === 0) return null;
  return (
    <div
      data-testid="identity-row-orgs"
      className={`${RIGA} overflow-x-auto overscroll-x-contain scrollbar-none`}
      style={{ paddingInline: ROW_INSET }}
    >
      {/* Il glifo dice di cosa parla la riga senza spendere una parola: e' il
          soggetto, come la faccia sopra e le facce sotto. */}
      <Building2 size={10} className="flex-shrink-0 text-app-text-muted" />
      {orgs.map((o) => (
        <button
          key={o.id}
          data-testid="org-chip"
          onClick={() => apriProfilo('organization')}
          className={`flex min-w-0 flex-shrink-0 items-center gap-1 rounded-full border border-app-border px-1.5 py-0.5 text-app-text-secondary ${SIDEBAR_HOVER}`}
          title={`${o.nome}\n${o.online > 0
            ? tr('statusBar.orgs.presence', { n: o.online, tot: o.membri })
            : tr('statusBar.orgs.nobody')}\n${tr('statusBar.orgs.open')}`}
          aria-label={`${o.nome} \u00b7 ${tr('statusBar.orgs.open')}`}
        >
          {o.logoUrl
            ? <img
                src={o.logoUrl}
                alt=""
                className="h-3.5 w-3.5 flex-shrink-0 rounded-full object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            : <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-[7px] font-bold text-indigo-400">
                {o.nome.slice(0, 2).toUpperCase()}
              </span>}
          <span className="max-w-[92px] truncate">{o.nome}</span>
          {o.online > 0
            ? (
              <span data-testid="org-chip-online" className={`flex flex-shrink-0 items-center gap-1 ${SEGNALE_OK}`}>
                <Facce facce={o.facce} />
                <span className="tabular-nums">{o.online}</span>
              </span>
            )
            // Nessuno online: un pallino spento, non uno zero. Lo zero e' un
            // numero da leggere; il pallino spento si vede senza leggerlo.
            : <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-app-text-muted/40" />}
        </button>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 3. AMICI
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * CHI C'E' ADESSO, con la faccia.
 *
 * A differenza delle due righe sopra questa resta anche quando non c'e'
 * nessuno: «nessuno online» e' la risposta alla domanda che la riga fa, e una
 * riga che sparisce quando la risposta e' zero e' una riga che non si impara a
 * guardare. Sparisce solo quando la domanda non ha senso, cioe' quando non
 * conosci nessuno.
 */
function RigaAmici({ online, totali }: { online: FacciaPresenza[]; totali: number }) {
  const tr = useT();
  if (totali === 0) return null;
  const ci_sono = online.length > 0;
  return (
    <button
      data-testid="identity-row-friends"
      onClick={() => apriProfilo('friends')}
      className={`${RIGA} text-left ${SIDEBAR_HOVER}`}
      style={{ paddingInline: ROW_INSET }}
      title={`${ci_sono ? online.map((f) => f.nome).join(', ') : tr('statusBar.friends.nobody')}\n${tr('statusBar.friends.open')}`}
      aria-label={tr('statusBar.friends.open')}
    >
      <Users size={10} className={`flex-shrink-0 ${ci_sono ? SEGNALE_OK : 'text-app-text-muted'}`} />
      {ci_sono && <Facce facce={online} />}
      <span className={`truncate ${ci_sono ? 'text-app-text-secondary' : 'text-app-text-muted'}`}>
        {ci_sono ? tr('statusBar.friends.online', { n: online.length }) : tr('statusBar.friends.nobody')}
      </span>
      {/* Il totale a destra e' il denominatore: «2 online» su quante persone. */}
      <span className="ml-auto flex-shrink-0 text-app-text-muted tabular-nums">{totali}</span>
    </button>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Le facce, sovrapposte come in una lista di partecipanti.
 *
 * Le prime quattro e basta: oltre, sono dischi da dodici pixel indistinguibili
 * larghi quanto il numero che li conterebbe, e il numero c'e' gia' accanto.
 */
function Facce({ facce }: { facce: FacciaPresenza[] }) {
  if (facce.length === 0) return null;
  return (
    <span className="flex flex-shrink-0 items-center">
      {facce.slice(0, MAX_FACCE).map((f, i) => (
        <span
          key={f.id}
          // Il bordo del colore del chrome e' cio' che separa due facce
          // sovrapposte: senza, a dodici pixel si leggono come una macchia sola.
          className={`flex h-3.5 w-3.5 items-center justify-center overflow-hidden rounded-full ring-1 ring-app-chrome ${i > 0 ? '-ml-1' : ''}`}
          title={f.nome}
        >
          {f.avatarUrl
            ? <img src={f.avatarUrl} alt="" className="h-full w-full object-cover" />
            : <span className="flex h-full w-full items-center justify-center bg-primary/20 text-[7px] font-semibold leading-none text-app-text-secondary">
                {f.iniziali}
              </span>}
        </span>
      ))}
    </span>
  );
}
