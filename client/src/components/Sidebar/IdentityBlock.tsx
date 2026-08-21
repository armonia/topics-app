/**
 * IL BLOCCO DELL'IDENTITA', in fondo alla colonna: tre domande, un blocco solo.
 *
 *   1. IO         chi sono, su cosa sto, e cosa sta lavorando adesso
 *   2. ORG        con chi sto: un chip per organizzazione, con chi c'e' dentro
 *   3. AMICI      chi ho intorno: le facce di chi e' online adesso
 *
 * ── NIENTE RIGHE, UN BLOCCO ─────────────────────────────────────────────────
 * Prima le tre erano tre strisce con un filo grigio in mezzo e un'altezza
 * fissa ciascuna. Tre bordi in venti pixel di altezza disegnano tre scatole, e
 * tre scatole impilate in fondo a una colonna si leggono come tre barre di
 * stato di tre applicazioni diverse: il filo separava cose che sono gia'
 * separate dal fatto di stare su righe diverse, e in cambio spezzava il fondo
 * della colonna in fette.
 *
 * Adesso il separatore non c'e' e il blocco e' immerso nel chrome: cio' che
 * distingue le tre domande e' il PRIMO GLIFO di ciascuna (la tua faccia, i
 * loghi dei gruppi, il glifo delle persone), che e' un segnale piu' forte di
 * una linea perche' dice anche DI COSA si parla, non solo dove finisce la riga
 * precedente.
 *
 * ── VA A CAPO, NON SCORRE ───────────────────────────────────────────────────
 * I chip delle organizzazioni stavano su una riga che scorreva in orizzontale.
 * Uno scroll orizzontale dentro una colonna larga 240px e' un contenuto
 * nascosto senza che niente lo dica: il quarto gruppo esiste solo se ti viene
 * in mente di trascinare. Adesso i chip vanno a capo da soli e il blocco
 * cresce di quel tanto — che e' anche l'unico modo perche' «con chi sto» sia
 * una domanda con una risposta VISIBILE invece che una da scoprire.
 *
 * ── OGNI COSA APRE IL SUO PANNELLO ──────────────────────────────────────────
 * Ogni chip apre un dropdown (`PresencePopover`) invece di saltare subito a una
 * pagina. Il salto immediato costringeva a cambiare schermata per rispondere a
 * domande piccole — «chi c'e' in questo gruppo?», «quante macchine ho
 * autorizzato?» — e poi a tornare indietro. Il pannello risponde sul posto e
 * tiene il link alla pagina in fondo, per quando la domanda e' davvero grossa:
 * la scorciatoia resta, ma smette di essere l'unica strada.
 *
 * ── AMICI C'E' SEMPRE, ANCHE A ZERO ─────────────────────────────────────────
 * Prima spariva quando non conoscevi nessuno. Una riga che esiste solo quando
 * ha buone notizie e' una riga di cui non si impara il posto, e soprattutto
 * lascia senza risposta la domanda «ma questa cosa degli amici dove sta?»
 * proprio a chi non ha ancora nessuno, cioe' l'unico che deve poterci entrare
 * per cominciare. Adesso resta, dice zero, e il suo pannello spiega da dove
 * arrivano le persone.
 */
import { useCallback, useEffect, useState } from 'react';
import { Building2, ChevronRight, Monitor, Smartphone, Users } from 'lucide-react';
import { subscribeSession, type SessionState } from '@/lib/auth/session';
import { etichettaIdentita } from './identityLabel';
import { useIdentityPresence, type OrgConPresenza } from '@/hooks/useIdentityPresence';
import { usePresenceSummary } from '@/hooks/usePresenceSummary';
import { apriProfilo } from '@/state/profileTarget';
import type { FacciaPresenza, RigaPresenza } from './orgPresence';
import { ROW_INSET, SIDEBAR_HOVER } from '@/lib/selectionStyles';
import { PALLINO_OK, SEGNALE_OK } from './chromeSignals';
import { POPOVER_ITEM } from '@/lib/popoverStyles';
import { PresencePopover } from './PresencePopover';
import { useT } from '@/hooks/useT';

/** Le tre file: nessun bordo, nessuna altezza fissa, e i figli vanno a capo.
 *  `gap-y` piccolo perche' quando va a capo le due file restano UNA cosa. */
const FILA = 'flex w-full flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px]';

/** Un chip immerso: nessun bordo a riposo, il rialzo arriva col puntatore.
 *  Il bordo tondo c'era per dire «sono cliccabile», ma erano cinque bordi in
 *  una fascia alta trenta pixel; l'hover lo dice meglio e solo quando serve. */
const CHIP = `flex min-w-0 items-center gap-1 rounded px-1 py-0.5 ${SIDEBAR_HOVER}`;

/** Quante facce si mostrano prima di passare al numero. Oltre quattro sono
 *  puntini indistinguibili larghi quanto la parola che li conterebbe. */
const MAX_FACCE = 4;

/** In the org chip the name is gone, so the room it took goes to the faces:
 *  six fit on the line the name used to fill by itself. */
const MAX_FACCE_ORG = 6;

export function IdentityBlock({ onOpenDevices }: { onOpenDevices?: () => void }) {
  const presenza = useIdentityPresence();
  return (
    <div
      data-testid="identity-block"
      className="flex flex-col gap-y-0.5 pb-1"
      style={{ paddingInline: ROW_INSET }}
    >
      <RigaIo presenza={presenza} onOpenDevices={onOpenDevices} />
      <RigaOrganizzazioni orgs={presenza.orgs} />
      <RigaAmici online={presenza.amiciOnline} tutti={presenza.amiciTutti} totali={presenza.amiciTotali} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 1. IO
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * TUTTO CIO' CHE MI RIGUARDA, su una linea sola.
 *
 * La faccia e il nome sono il soggetto; il ferro e' il dettaglio; il lavoro in
 * corso chiude a destra. Il conteggio dei dispositivi non sta piu' sulla riga:
 * e' sceso dentro il pannello, perche' «2/3» accanto a un'icona di telefono era
 * il pezzo che ogni volta andava spiegato, e nel pannello ha una frase intera.
 */
function RigaIo({ presenza, onOpenDevices }: {
  presenza: ReturnType<typeof useIdentityPresence>;
  onOpenDevices?: () => void;
}) {
  const tr = useT();
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [ferri, setFerri] = useState<{ connessi: number; totali: number } | null>(null);
  const [aperto, setAperto] = useState(false);
  const [chip, setChip] = useState<HTMLButtonElement | null>(null);
  const { summary } = usePresenceSummary();
  useEffect(() => subscribeSession(setSession), []);

  const chi = etichettaIdentita(presenza.io, session);

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
    <div data-testid="identity-row-me" className={FILA}>
      <button
        ref={setChip}
        data-testid="identity-me-profile"
        onClick={() => setAperto((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={aperto}
        className={`${CHIP} -mx-1 flex-1 text-left`}
        title={`${chi.nome}${chi.dettaglio ? ` \u00b7 ${chi.dettaglio}` : ''}`}
      >
        {/* LA FACCIA, e solo quando c'e' una persona: un tondino con dentro
            l'iniziale di «Questo computer» sarebbe un avatar finto. */}
        {chi.personale
          ? (chi.avatarUrl
              ? <img src={chi.avatarUrl} alt="" className="h-4 w-4 flex-shrink-0 rounded-full object-cover" />
              : <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[8px] font-semibold leading-none text-white">{chi.iniziali}</span>)
          : <Ferro size={10} className="flex-shrink-0 text-app-text-secondary" />}
        <span className="truncate text-app-text">{chi.nome}</span>
        {/* IL LAVORO IN CORSO, con le stesse parole che Topics pubblica sulla
            presence: «3 al lavoro · 12 aperte». */}
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

      {aperto && (
        <PresencePopover
          anchorEl={chip}
          onClose={() => setAperto(false)}
          testId="identity-me-panel"
          titolo={
            <>
              {chi.personale && chi.avatarUrl
                ? <img src={chi.avatarUrl} alt="" className="h-5 w-5 flex-shrink-0 rounded-full object-cover" />
                : <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-semibold leading-none text-white">{chi.iniziali || '?'}</span>}
              <span className="truncate">{chi.nome}</span>
            </>
          }
        >
          <div className="px-3 py-2 text-[11px]">
            {chi.dettaglio && (
              <Voce etichetta={tr('statusBar.me.machine')}>
                <Ferro size={11} className="flex-shrink-0 text-app-text-muted" />
                <span className="truncate">{chi.dettaglio}</span>
              </Voce>
            )}
            {summary && (
              <Voce etichetta={tr('statusBar.me.workRow')}>
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${PALLINO_OK}`} />
                <span className="truncate">{summary}</span>
              </Voce>
            )}
            {ferri && ferri.totali > 0 && (
              <Voce etichetta={tr('statusBar.me.devicesRow')}>
                <Ferro size={11} className="flex-shrink-0 text-app-text-muted" />
                <span className="tabular-nums">
                  {tr('statusBar.me.devicesCount', { n: ferri.connessi, tot: ferri.totali })}
                </span>
              </Voce>
            )}
          </div>
          <div className="border-t border-app-border py-1">
            <Azione onClick={() => { setAperto(false); apriProfilo('profile'); }} testId="identity-me-open-profile">
              {tr('statusBar.me.openProfile')}
            </Azione>
            {onOpenDevices && (
              <Azione onClick={() => { setAperto(false); onOpenDevices(); }} testId="identity-me-devices">
                {tr('statusBar.devicesTitle')}
              </Azione>
            )}
          </div>
        </PresencePopover>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 2. ORGANIZZAZIONI
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * ONE CHIP PER GROUP, and inside each chip the people who are there.
 *
 * Presence lives INSIDE the chip and not in a single count at the end of the
 * row: with two organizations "3 online" does not say which group they belong
 * to, and that is the first thing anyone wants to know.
 *
 * NO NAME IN THE CHIP. The name was the widest part of a chip that says
 * something else: two names filled a 240px column and left the faces, which are
 * the news, fighting for the leftovers. The logo already identifies the group
 * without spelling it, the tooltip and the panel header carry the full name,
 * and what is left on the row is exactly the answer to "who is around": the
 * faces, wrapping inside the chip when they are many.
 */
function RigaOrganizzazioni({ orgs }: { orgs: OrgConPresenza[] }) {
  const [apertaId, setApertaId] = useState<string | null>(null);
  if (orgs.length === 0) return null;
  return (
    <div data-testid="identity-row-orgs" className={FILA}>
      {/* Il glifo dice di cosa parla la fila senza spendere una parola: e' il
          soggetto, come la faccia sopra e le facce sotto. */}
      <Building2 size={10} className="flex-shrink-0 text-app-text-muted" />
      {orgs.map((o) => (
        <ChipOrg
          key={o.id}
          org={o}
          aperta={apertaId === o.id}
          onToggle={() => setApertaId((v) => (v === o.id ? null : o.id))}
          onClose={() => setApertaId(null)}
        />
      ))}
    </div>
  );
}

function ChipOrg({ org, aperta, onToggle, onClose }: {
  org: OrgConPresenza;
  aperta: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const tr = useT();
  const [chip, setChip] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={setChip}
        data-testid="org-chip"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={aperta}
        className={`${CHIP} flex-wrap text-app-text-secondary`}
        title={org.online > 0
          ? `${org.nome}\n${tr('statusBar.orgs.presence', { n: org.online, tot: org.membri })}`
          : org.nome}
      >
        <Logo org={org} size={3.5} />
        {/* Only the faces, and only when there are any. Nobody online is said
            by the chip being just a logo: an empty chip is already the answer,
            and it costs no word to read. */}
        {org.online > 0 && (
          <span data-testid="org-chip-online" className={`flex flex-wrap items-center gap-y-0.5 ${SEGNALE_OK}`}>
            <Facce facce={org.facce} max={MAX_FACCE_ORG} totale={org.online} />
          </span>
        )}
      </button>

      {aperta && (
        <PresencePopover
          anchorEl={chip}
          onClose={onClose}
          testId="org-panel"
          titolo={
            <>
              <Logo org={org} size={5} />
              <span className="truncate">{org.nome}</span>
              <span className="ml-auto flex-shrink-0 font-normal text-app-text-muted tabular-nums">
                {tr('statusBar.friends.count', { n: org.online, tot: org.membri })}
              </span>
            </>
          }
        >
          <Elenco
            gente={org.gente}
            vuoto={tr('statusBar.orgs.alone')}
          />
          {/* The door to management hangs on THE organization, not on the row:
              the row holds several groups, and "manage organizations" reached
              from nowhere in particular is a link you have to guess the target
              of. Here it is opened from the group whose people you are reading. */}
          <div className="border-t border-app-border py-1">
            <Azione onClick={() => { onClose(); apriProfilo('organization'); }} testId="org-open-manage">
              {tr('statusBar.orgs.manageOne')}
            </Azione>
          </div>
        </PresencePopover>
      )}
    </>
  );
}

function Logo({ org, size }: { org: OrgConPresenza; size: 3.5 | 5 }) {
  const cls = size === 5 ? 'h-5 w-5 text-[9px]' : 'h-3.5 w-3.5 text-[7px]';
  return org.logoUrl
    ? <img
        src={org.logoUrl}
        alt=""
        className={`${cls} flex-shrink-0 rounded-full object-cover`}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
      />
    : <span className={`${cls} flex flex-shrink-0 items-center justify-center rounded-full bg-indigo-500/20 font-bold text-indigo-400`}>
        {org.nome.slice(0, 2).toUpperCase()}
      </span>;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 3. AMICI
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * WHO IS AROUND RIGHT NOW, with their face. The row stays even when nobody is,
 * because a row that shows up only with good news is a row nobody learns the
 * place of.
 *
 * WHAT IT DOES NOT SAY IS "NOBODY ONLINE". An empty row spending a whole line
 * to report an absence is a line you read once and then learn to skip, and it
 * pushed the only thing worth clicking (the way in to your friends) behind a
 * piece of bad news. With nobody around the row says its own name instead, so
 * the glyph, the label and the count stay a door: one click opens the panel,
 * which is where friends are actually managed.
 */
function RigaAmici({ online, tutti, totali }: {
  online: FacciaPresenza[];
  tutti: RigaPresenza[];
  totali: number;
}) {
  const tr = useT();
  const [aperto, setAperto] = useState(false);
  const [chip, setChip] = useState<HTMLButtonElement | null>(null);
  const ci_sono = online.length > 0;
  return (
    <div data-testid="identity-row-friends" className={FILA}>
      <button
        ref={setChip}
        data-testid="identity-friends-chip"
        onClick={() => setAperto((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={aperto}
        className={`${CHIP} -mx-1 flex-1 text-left`}
        title={ci_sono ? online.map((f) => f.nome).join(', ') : tr('statusBar.friends.title')}
      >
        <Users size={10} className={`flex-shrink-0 ${ci_sono ? SEGNALE_OK : 'text-app-text-muted'}`} />
        {ci_sono && <Facce facce={online} totale={online.length} />}
        <span className={`truncate ${ci_sono ? 'text-app-text-secondary' : 'text-app-text-muted'}`}>
          {ci_sono ? tr('statusBar.friends.online', { n: online.length }) : tr('statusBar.friends.title')}
        </span>
        {/* Il totale a destra e' il denominatore: «2 online» su quante persone.
            A zero resta e dice zero: e' il numero che spiega perche' la fila
            sopra e' vuota. */}
        <span data-testid="identity-friends-total" className="ml-auto flex-shrink-0 text-app-text-muted tabular-nums">
          {totali}
        </span>
      </button>

      {aperto && (
        <PresencePopover
          anchorEl={chip}
          onClose={() => setAperto(false)}
          testId="friends-panel"
          titolo={
            <>
              <Users size={12} className="flex-shrink-0 text-app-text-muted" />
              <span className="truncate">{tr('statusBar.friends.title')}</span>
              <span className="ml-auto flex-shrink-0 font-normal text-app-text-muted tabular-nums">
                {tr('statusBar.friends.count', { n: online.length, tot: totali })}
              </span>
            </>
          }
        >
          <Elenco gente={tutti} vuoto={tr('statusBar.friends.none')} suggerimento={tr('statusBar.friends.noneHint')} />
          <div className="border-t border-app-border py-1">
            <Azione onClick={() => { setAperto(false); apriProfilo('friends'); }} testId="friends-open-all">
              {tr('statusBar.friends.manage')}
            </Azione>
          </div>
        </PresencePopover>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * L'ELENCO DELLE PERSONE dentro un pannello: presenti in cima, assenti sotto.
 *
 * I due gruppi sono separati da un'etichetta e non solo dal colore del pallino:
 * il colore dice lo stato di UNA riga, l'etichetta dice dove finisce il gruppo
 * che stai scorrendo — che e' l'informazione che serve quando le righe sono
 * venti e le prime tre sono verdi.
 *
 * IL TETTO E LO SCROLL, non l'elenco intero: un'organizzazione con quaranta
 * persone renderebbe il pannello piu' alto della finestra, e `computeMenuPosition`
 * lo incollerebbe al bordo. Sette righe e mezza sono il punto in cui si vede che
 * c'e' altro sotto senza che il pannello diventi una pagina.
 */
function Elenco({ gente, vuoto, suggerimento }: {
  gente: RigaPresenza[];
  vuoto: string;
  suggerimento?: string;
}) {
  const tr = useT();
  if (gente.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-app-text-muted">
        <div>{vuoto}</div>
        {suggerimento && <div className="mt-0.5 text-app-text-muted/80">{suggerimento}</div>}
      </div>
    );
  }
  const presenti = gente.filter((p) => p.presente);
  const assenti = gente.filter((p) => !p.presente);
  return (
    <div className="max-h-[188px] overflow-y-auto py-1">
      {presenti.map((p) => <Persona key={p.id} p={p} />)}
      {assenti.length > 0 && (
        <>
          {presenti.length > 0 && (
            <div className="px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-app-text-muted">
              {tr('statusBar.presence.offlineGroup')}
            </div>
          )}
          {assenti.map((p) => <Persona key={p.id} p={p} />)}
        </>
      )}
    </div>
  );
}

function Persona({ p }: { p: RigaPresenza }) {
  return (
    <div
      data-testid="presence-person"
      data-online={p.presente ? 'true' : 'false'}
      className="flex items-center gap-2 px-3 py-1 text-[11px]"
      title={p.nome}
    >
      <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full ${p.presente ? '' : 'opacity-50'}`}>
        {p.avatarUrl
          ? <img src={p.avatarUrl} alt="" className="h-full w-full object-cover" />
          : <span className="flex h-full w-full items-center justify-center bg-primary/20 text-[8px] font-semibold leading-none text-app-text-secondary">
              {p.iniziali}
            </span>}
      </span>
      <span className={`truncate ${p.presente ? 'text-app-text' : 'text-app-text-muted'}`}>{p.nome}</span>
      <span
        className={`ml-auto h-1.5 w-1.5 flex-shrink-0 rounded-full ${p.presente ? PALLINO_OK : 'bg-app-text-muted/40'}`}
      />
    </div>
  );
}

/** Una coppia etichetta/valore nel pannello dell'identita'. L'etichetta e' cio'
 *  che sulla riga chiusa non c'era spazio di scrivere. */
function Voce({ etichetta, children }: { etichetta: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="flex-shrink-0 text-app-text-muted">{etichetta}</span>
      <span className="ml-auto flex min-w-0 items-center gap-1 text-app-text-secondary">{children}</span>
    </div>
  );
}

/** La riga-azione in fondo a un pannello: e' il link alla pagina che governa
 *  cio' che il pannello mostra. Il chevron dice che si esce di qui. */
function Azione({ onClick, children, testId }: {
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button data-testid={testId} onClick={onClick} className={POPOVER_ITEM}>
      <span className="truncate">{children}</span>
      <ChevronRight size={12} className="ml-auto flex-shrink-0 text-app-text-muted" />
    </button>
  );
}

/**
 * The faces, overlapped the way a participant list does it.
 *
 * ONLY THE FIRST FEW, then a number. Past the cap they are twelve-pixel discs
 * nobody can tell apart, each as wide as the digit that would count them; the
 * `+N` says the same thing in less room and stays readable.
 */
function Facce({ facce, max = MAX_FACCE, totale }: {
  facce: FacciaPresenza[];
  max?: number;
  /** How many are online in total: the `+N` counts the ones with no face too. */
  totale?: number;
}) {
  if (facce.length === 0) return null;
  const oltre = (totale ?? facce.length) - Math.min(facce.length, max);
  return (
    <span className="flex flex-shrink-0 items-center">
      {facce.slice(0, max).map((f, i) => (
        <span
          key={f.id}
          data-testid="presence-face"
          // The chrome-coloured ring is what keeps two overlapping faces apart:
          // without it, at twelve pixels they read as a single smudge.
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
      {oltre > 0 && (
        <span data-testid="presence-faces-more" className="ml-0.5 tabular-nums">+{oltre}</span>
      )}
    </span>
  );
}
