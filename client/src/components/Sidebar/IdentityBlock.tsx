/**
 * THE IDENTITY BLOCK, at the bottom of the column: three questions, one block.
 *
 *   1. ME      who I am, what machine I am on, what is working right now
 *   2. ORGS    who I am with: one chip per organisation, with who is inside it
 *   3. FRIENDS who is around me: the faces of whoever is online now
 *
 * NO ROWS, ONE BLOCK.
 * They used to be three strips with a grey thread between them and a fixed
 * height each. Three borders inside twenty pixels of height draw three boxes,
 * and three boxes stacked at the bottom of a column read as the status bars of
 * three different applications: the thread separated things that are already
 * separated by being on different lines, and in exchange it cut the bottom of
 * the column into slices.
 *
 * Now there is no separator and the block sits immersed in the chrome: what
 * tells the three questions apart is the FIRST GLYPH of each one (your face,
 * the group logos, the people glyph), which is a stronger signal than a line
 * because it also says WHAT the row is about, not just where the previous one
 * ended.
 *
 * ONE LINE, THREE CHIPS, ALWAYS THE SAME THREE.
 * The three subjects are not three rows, and they are not a wrapping flow
 * either: they are three mini-cards on ONE line, at every sidebar width. The
 * wrapping flow was better than the three fixed rows it replaced, but it made
 * the band's own shape depend on the data: the same installation showed one
 * line or three depending on how many groups you had joined that week, and a
 * place whose SHAPE changes is a place you have to re-read every time instead
 * of glancing at. One line is what makes the band a place.
 *
 * The line holds because each subject knows what to give up: the name of
 * whoever is logged in truncates (it is the only elastic thing here), and the
 * groups past the second collapse into a `+n` chip. Nothing is hidden without
 * a mark saying so.
 *
 * IT DOES NOT WRAP AND IT DOES NOT SCROLL.
 * The organisation chips used to sit on a row that scrolled sideways, and then
 * on one that wrapped. A horizontal scroll inside a 240px column is content
 * hidden with nothing to say so: the fourth group exists only if it occurs to
 * you to drag. The `+n` chip is the third answer: it is VISIBLE, it says how
 * many are behind it, and it opens them in a panel.
 *
 * FULL AND EMPTY ARE TOLD APART BY THE CHIP, NOT BY ABSENCE.
 * A subject with nothing in it is drawn as an outlined chip instead of
 * disappearing (`identityChip.ts` holds the recipe). The groups chip used to
 * not render at all at zero, which is how "which groups am I in" ended up
 * unanswerable for whoever was in none. Three slots, always three, and one
 * glance counts the filled ones.
 *
 * EVERY THING OPENS ITS OWN PANEL.
 * Each chip opens a dropdown (`PresencePopover`) instead of jumping straight to
 * a page. The immediate jump forced a whole screen change to answer small
 * questions ("who is in this group?", "how many machines have I authorised?")
 * and then a trip back. The panel answers on the spot and keeps the link to the
 * page at its bottom, for when the question really is a big one: the shortcut
 * survives, it just stops being the only road.
 *
 * FRIENDS IS ALWAYS THERE, EVEN AT ZERO.
 * It used to disappear when you knew nobody. A row that exists only when it has
 * good news is a row whose place nobody learns, and above all it leaves "but
 * where is this friends thing?" unanswered for the very person who has nobody
 * yet, that is, the only one who needs to get in to begin. Now it stays, it
 * says zero, and its panel explains where the people come from.
 */
import { useCallback, useEffect, useState } from 'react';
import { Bot, Building2, ChevronRight, Hourglass, ListChecks, MessagesSquare, Monitor, Smartphone, Users } from 'lucide-react';
import { subscribeSession, type SessionState } from '@/lib/auth/session';
import { etichettaIdentita } from './identityLabel';
import { useIdentityPresence, type OrgConPresenza } from '@/hooks/useIdentityPresence';
import { usePresenceSummary } from '@/hooks/usePresenceSummary';
import { apriProfilo, openPersonProfile } from '@/state/profileTarget';
import type { FacciaPresenza, RigaPresenza } from './orgPresence';
import { IDENTITY_GLYPH_BOX, IDENTITY_GLYPH_INK, ROW_INSET, TIER_DONE_TEXT } from '@/lib/selectionStyles';
import { CHIP_INK_DIM, chipClass, splitOrgs } from './identityChip';
import { PALLINO_OK, SEGNALE_ATTESA, SEGNALE_OK } from './chromeSignals';
import { POPOVER_ITEM } from '@/lib/popoverStyles';
import { PresencePopover } from './PresencePopover';
import { workSignals, type SignalKind } from './workSignals';
import { useAgentActivityCounts } from '@/state/signals';
import { useTopics, useTerminalSessions } from '@/contexts/TopicsContext';
import { openSettings } from '@/lib/openSettings';
import { useT } from '@/hooks/useT';

/**
 * A subject on the line.
 *
 * The default is `flex: 0 1 auto` (grow no, shrink yes): a subject asks for
 * exactly its content and gives room back only when the line runs out. Who
 * gives it back FIRST is decided per subject, and the order matters:
 *
 *   1. "me" (`flex-1 basis-0`) asks for nothing and takes the leftover, so it
 *      is the first to yield and the name truncates;
 *   2. "people" yields next, and what it drops is its own word, not its count;
 *   3. the groups (`flex-none`) never yield: a squashed logo is not a smaller
 *      logo, it is an unrecognisable one.
 */
const SUBJECT = 'flex min-w-0 items-center';

/** How many faces are shown before switching to a number. Past four they are
 *  indistinguishable dots, each as wide as the word that would count them. */
const MAX_FACCE = 4;

/** In the group chip the faces share a line with two other subjects now, so
 *  the six that fitted while the chip could wrap became the reason the row
 *  could not hold. Two faces and a count: the count is the part that stays
 *  true past two anyway. */
const MAX_FACCE_ORG = 2;

export function IdentityBlock({ onOpenDevices }: { onOpenDevices?: () => void }) {
  const presenza = useIdentityPresence();
  return (
    // `flex-nowrap` is the whole promise of the band, and `overflow-hidden` is
    // what makes it a promise instead of a hope: if a subject ever refuses to
    // shrink, the column must not grow a horizontal scrollbar to accommodate
    // it. The e2e measures both (same top within 1px, scrollWidth == clientWidth).
    <div
      data-testid="identity-block"
      className="@container/identity flex flex-nowrap items-center gap-1 overflow-hidden pb-1 text-[11px]"
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
 * EVERYTHING ABOUT ME, in one chip.
 *
 * The face and the name are the subject; the machine is the detail; what is
 * running closes the chip as GLYPHS AND DIGITS, not as a sentence. The phrase
 * ("3 al lavoro / 12 aperte" allow-italian: it is the string the bar showed)
 * said the same three words every day and pushed
 * the name into an ellipsis to do it: the digits are the part that changes, and
 * they arrived last, so they were the first to be cut. Now the sentence is the
 * tooltip and the panel, and the chip carries the numbers.
 *
 * THESE NUMBERS ARE THE ONES THE STATUS BAR USED TO SHOW. The robot and the
 * hourglass were down there, one strip below, next to the megabytes: two places
 * counting the same fleet, and neither of them next to the person the fleet
 * belongs to. They moved up here, and the bar below lost them for good rather
 * than keeping a second copy.
 *
 * The device count is not on the chip: it lives in the panel, because "2/3"
 * next to a phone glyph was the piece that had to be explained every time.
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
  const { counts, summary } = usePresenceSummary();
  const agentCounts = useAgentActivityCounts(useTerminalSessions(), useTopics());
  useEffect(() => subscribeSession(setSession), []);

  const chi = etichettaIdentita(presenza.io, session);

  const caricaFerri = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/devices', { credentials: 'same-origin' });
      if (!r.ok) return;
      const b = await r.json() as { devices: Array<{ connected: boolean; revokedAt: number | null }> };
      const vivi = (b.devices ?? []).filter((d) => d.revokedAt === null);
      setFerri({ connessi: vivi.filter((d) => d.connected).length, totali: vivi.length });
    } catch { /* transient: the row keeps no count rather than lie about one */ }
  }, []);

  useEffect(() => {
    const chiedi = () => { void caricaFerri(); };
    // After the first paint: nobody needs the device count in the first frame,
    // and a synchronous state write on mount is exactly what
    // `set-state-in-effect` flags.
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

  const awaitingDone = agentCounts ? agentCounts.awaiting - agentCounts.awaitingInput : 0;
  const signals = workSignals({
    openSessions: counts?.openSessions ?? 0,
    workingSessions: counts?.workingSessions ?? 0,
    activeTasks: counts?.activeTasks ?? 0,
    awaitingInput: agentCounts?.awaitingInput ?? 0,
    awaitingDone: awaitingDone > 0 ? awaitingDone : 0,
  });
  // The whole story stays reachable on hover: the chip is the headline, this is
  // the paragraph, and the panel below is the page.
  const workStory = [
    summary ?? '',
    agentCounts && agentCounts.awaitingInput > 0 ? tr('statusBar.agents.awaitingInput', { n: agentCounts.awaitingInput }) : '',
    awaitingDone > 0 ? tr('statusBar.agents.toLookAt', { n: awaitingDone }) : '',
  ].filter(Boolean).join('\n');

  return (
    // THE ONE ELASTIC SUBJECT. Everything on this line has a size it will not
    // give up (a glyph, two faces, a digit) except the name, which is also the
    // only thing here that reads fine half-shown. So "me" takes the leftover
    // width and yields it back, in that order: `flex-1` with `basis-0` and
    // `min-w-0`, i.e. it asks for nothing and accepts what is left. That is
    // what keeps the other two on the line at 180px instead of pushing them off.
    // `min-w-6` IS THE 24px TARGET, PUT ON THE PART THAT ACTUALLY SHRINKS.
    // The floor was on the button alone, and a floor under the wrong box is not
    // a floor: `basis-0` let THIS span be squeezed to nothing by the groups,
    // while the button inside kept its 24px and simply painted outside its
    // parent, straight over the next chip. Measured at 180px with four groups:
    // the row was ~4px wide, the button drew 6..30, the groups opened at 10.
    // An overlap reads as a pile, which is the exact failure the redesign was
    // called in to fix, so the constraint belongs to the flex item that yields.
    <span data-testid="identity-row-me" className={`${SUBJECT} min-w-6 flex-1 basis-0`}>
      <button
        ref={setChip}
        data-testid="identity-me-profile"
        onClick={() => setAperto((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={aperto}
        // NO negative margin. `-mx-1` cancelled the chip's own padding, so this
        // subject started four pixels to the LEFT of the others. The hover
        // surface it widened is worth less than the one edge every subject
        // mark shares.
        // Always FULL: if this chip is drawn at all you are paired, so this
        // subject is never the empty one.
        className={`${chipClass(true)} min-w-0 flex-1 text-left`}
        title={[`${chi.nome}${chi.dettaglio ? ` \u00b7 ${chi.dettaglio}` : ''}`, workStory].filter(Boolean).join('\n')}
      >
        {/* THE FACE, and only when there is a person: a disc holding the
            initial of "This computer" would be a fake avatar.
            THE SAME BOX AS THE OTHER TWO SUBJECTS: it was `h-4` against their
            10px marks, which is three left edges instead of one. The box is
            shared, the ink inside it is not. */}
        <span data-testid="identity-glyph" className={`flex ${IDENTITY_GLYPH_BOX} flex-shrink-0 items-center justify-center`}>
          {chi.personale
            ? (chi.avatarUrl
                ? <img src={chi.avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
                : <span className="flex h-full w-full items-center justify-center rounded-full bg-primary text-[7px] font-semibold leading-none text-white">{chi.iniziali}</span>)
            : <Ferro size={IDENTITY_GLYPH_INK} className="text-app-text-secondary" />}
        </span>
        <span className="truncate text-app-text">{chi.nome}</span>
        {/* WHAT IS RUNNING, in glyphs. `workSignals` decides which three:
            what is alive first, the inventory last, zeros never. */}
        {signals.length > 0 && (
          // WHAT YIELDS WHEN THE COLUMN IS NARROW. The glyph and these signals
          // are the only parts of the chip that refuse to shrink, so on a 180px
          // column they kept drawing their full width straight over the groups
          // chip: 84px of spill, measured. The name truncating is not enough
          // give, because the floor is the chip's own 24px target.
          // The threshold is the band's own width, not the window's, and 300 is
          // measured rather than chosen: the band is the sidebar less the 6px
          // inset each side, so the three test widths give 168, 244 and 388. At
          // 244 the chip is still 10px short of holding glyph, a name clipped
          // to its ellipsis, the signals and the two other subjects. 388 has
          // the room with a margin. Anything under 300 is the narrow case.
          // So below a band of 300px the signals go, and they are the right
          // thing to lose: the subject of this chip is WHO you are, the numbers
          // are what is running, and they are already in the tooltip and in the
          // panel the chip opens. Losing them costs a hover; losing the line
          // costs the glance the whole band exists for.
          <span
            data-testid="presence-summary"
            className="ml-auto hidden flex-shrink-0 items-center gap-1.5 tabular-nums @[300px]/identity:flex"
          >
            {signals.map((s) => <Signal key={s.kind} kind={s.kind} n={s.n} />)}
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
              <Voce label={tr('statusBar.me.machine')}>
                <Ferro size={11} className="flex-shrink-0 text-app-text-muted" />
                <span className="truncate">{chi.dettaglio}</span>
              </Voce>
            )}
            {summary && (
              <Voce label={tr('statusBar.me.workRow')}>
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${PALLINO_OK}`} />
                <span className="truncate">{summary}</span>
              </Voce>
            )}
            {/* The fleet, spelled out. On the chip it is glyphs and digits; the
                panel is where "what is this hourglass" gets its sentence, and
                it is the sentence the status bar used to hide in a tooltip. */}
            {agentCounts && (agentCounts.awaitingInput > 0 || awaitingDone > 0) && (
              <Voce label={tr('statusBar.agents.heading')}>
                {agentCounts.awaitingInput > 0 && (
                  <span className={`flex items-center gap-1 ${SEGNALE_ATTESA}`} title={tr('statusBar.agents.awaitingInput', { n: agentCounts.awaitingInput })}>
                    <Hourglass size={11} />
                    <span className="tabular-nums">{agentCounts.awaitingInput}</span>
                  </span>
                )}
                {awaitingDone > 0 && (
                  <span className={`flex items-center gap-1 ${TIER_DONE_TEXT}`} title={tr('statusBar.agents.toLookAt', { n: awaitingDone })}>
                    <Hourglass size={11} />
                    <span className="tabular-nums">{awaitingDone}</span>
                  </span>
                )}
              </Voce>
            )}
            {ferri && ferri.totali > 0 && (
              <Voce label={tr('statusBar.me.devicesRow')}>
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
    </span>
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
 * faces.
 *
 * AND IT IS THERE AT ZERO. It used to return null with no groups, which made
 * the band two chips wide and left the third question unasked. Now the subject
 * holds its slot as an outlined chip that opens the panel explaining what an
 * organisation is and how you end up in one: same reason the people chip stays
 * at zero, and the same person is the one who needs it.
 */
function RigaOrganizzazioni({ orgs }: { orgs: OrgConPresenza[] }) {
  const [apertaId, setApertaId] = useState<string | null>(null);
  // No leading glyph any more: it was there to tell one ROW from the next, and
  // there are no rows left. Alignment survives without it: every subject now
  // opens with a mark of the same IDENTITY_GLYPH_BOX size (the face, a group
  // logo, the people sign) sitting inside a chip with the same padding, so
  // the left edges agree by construction instead of by hand-tuned margins.
  if (orgs.length === 0) {
    return (
      <span data-testid="identity-row-orgs" className={`${SUBJECT} flex-none`}>
        <EmptyOrgChip />
      </span>
    );
  }
  const { inline, extra } = splitOrgs(orgs);
  return (
    <span data-testid="identity-row-orgs" className={`${SUBJECT} flex-none gap-1`}>
      {inline.map((o) => (
        <ChipOrg
          key={o.id}
          org={o}
          aperta={apertaId === o.id}
          onToggle={() => setApertaId((v) => (v === o.id ? null : o.id))}
          onClose={() => setApertaId(null)}
        />
      ))}
      {extra > 0 && (
        <MoreOrgsChip
          orgs={orgs.slice(inline.length)}
          aperta={apertaId === MORE_ORGS_KEY}
          onToggle={() => setApertaId((v) => (v === MORE_ORGS_KEY ? null : MORE_ORGS_KEY))}
          onClose={() => setApertaId(null)}
        />
      )}
    </span>
  );
}

/** The open-panel key of the `+n` chip. It shares `apertaId` with the group
 *  chips because only one panel may be open at a time, and an id no group can
 *  have is cheaper than a second piece of state that can disagree with this one. */
const MORE_ORGS_KEY = '\u0000more';

/**
 * NO GROUPS: the slot stays, drawn as an outline, and it is the only place in
 * the product that answers "what is an organisation" to somebody who is in
 * none. Before, it answered by not being there.
 */
function EmptyOrgChip() {
  const tr = useT();
  const [aperto, setAperto] = useState(false);
  const [chip, setChip] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={setChip}
        data-testid="org-chip-empty"
        onClick={() => setAperto((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={aperto}
        className={`${chipClass(false)} justify-center text-app-text-secondary`}
        title={tr('statusBar.orgs.noneTitle')}
      >
        <span data-testid="identity-glyph" className={`flex ${IDENTITY_GLYPH_BOX} flex-shrink-0 items-center justify-center`}>
          <Building2 size={IDENTITY_GLYPH_INK} />
        </span>
        <span className="flex-shrink-0 tabular-nums">0</span>
      </button>

      {aperto && (
        <PresencePopover
          anchorEl={chip}
          onClose={() => setAperto(false)}
          testId="org-empty-panel"
          titolo={
            <>
              <Building2 size={12} className="flex-shrink-0 text-app-text-muted" />
              <span className="truncate">{tr('statusBar.orgs.noneTitle')}</span>
            </>
          }
        >
          <div className="px-3 py-2 text-[11px] text-app-text-secondary">
            {tr('statusBar.orgs.noneHint')}
          </div>
          <div className="border-t border-app-border py-1">
            <Azione onClick={() => { setAperto(false); openSettings('organization'); }} testId="org-empty-manage">
              {tr('statusBar.orgs.manageAll')}
            </Azione>
          </div>
        </PresencePopover>
      )}
    </>
  );
}

/**
 * THE GROUPS THAT DID NOT FIT, as a chip that says how many they are.
 *
 * This is the price of one line, and it is paid out loud: `+3` is a thing you
 * can see and press, unlike the sideways scroll it replaces, where the fourth
 * group existed only if it occurred to you to drag. The panel lists them with
 * their presence, so the count on the chip is never the end of the answer.
 */
function MoreOrgsChip({ orgs, aperta, onToggle, onClose }: {
  orgs: OrgConPresenza[];
  aperta: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const tr = useT();
  const [chip, setChip] = useState<HTMLButtonElement | null>(null);
  const presentNow = orgs.reduce((n, o) => n + o.online, 0);
  return (
    <>
      <button
        ref={setChip}
        data-testid="org-chip-more"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={aperta}
        className={`${chipClass(true)} justify-center text-app-text-secondary`}
        title={tr('statusBar.orgs.more', { n: orgs.length })}
      >
        <span className="flex-shrink-0 tabular-nums">+{orgs.length}</span>
        {presentNow > 0 && <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${PALLINO_OK}`} />}
      </button>

      {aperta && (
        <PresencePopover
          anchorEl={chip}
          onClose={onClose}
          testId="org-more-panel"
          titolo={
            <>
              <Building2 size={12} className="flex-shrink-0 text-app-text-muted" />
              <span className="truncate">{tr('statusBar.orgs.more', { n: orgs.length })}</span>
            </>
          }
        >
          <div className="py-1">
            {orgs.map((o) => (
              <div key={o.id} data-testid="org-more-row" className={`${POPOVER_ITEM} gap-2`}>
                <Logo org={o} size={5} />
                <span className="min-w-0 flex-1 truncate">{o.nome}</span>
                <span className={`flex-shrink-0 tabular-nums ${o.online > 0 ? SEGNALE_OK : CHIP_INK_DIM}`}>
                  {tr('statusBar.friends.count', { n: o.online, tot: o.membri })}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-app-border py-1">
            <Azione onClick={() => { onClose(); openSettings('organization'); }} testId="org-more-manage">
              {tr('statusBar.orgs.manageAll')}
            </Azione>
          </div>
        </PresencePopover>
      )}
    </>
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
        // A group you are in is a FULL chip even with nobody online: what the
        // fill answers is "am I in a group", and the faces answer the other
        // question inside it.
        className={`${chipClass(true)} justify-center text-app-text-secondary`}
        title={org.online > 0
          ? `${org.nome}\n${tr('statusBar.orgs.presence', { n: org.online, tot: org.membri })}`
          : org.nome}
      >
        <Logo org={org} size={3.5} />
        {/* Only the faces, and only when there are any. Nobody online is said
            by the chip being just a logo: an empty chip is already the answer,
            and it costs no word to read. It does not wrap any more either: on
            a single-line band a chip that grows downwards takes the whole band
            with it, so past two faces the count carries the rest. */}
        {org.online > 0 && (
          <span data-testid="org-chip-online" className={`flex flex-none items-center ${SEGNALE_OK}`}>
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
            <Azione onClick={() => { onClose(); openSettings('organization'); }} testId="org-open-manage">
              {tr('statusBar.orgs.manageOne')}
            </Azione>
          </div>
        </PresencePopover>
      )}
    </>
  );
}

/**
 * A group's logo, and in the band it IS that subject's opening mark: same
 * IDENTITY_GLYPH_BOX as the face and the people sign, so the three subjects
 * agree on one left edge without a margin tuned by hand. That is why it
 * carries the `identity-glyph` marker only at the band size: the popover uses
 * the bigger one, which opens nothing.
 */
function Logo({ org, size }: { org: OrgConPresenza; size: 3.5 | 5 }) {
  const inBanda = size !== 5;
  const cls = inBanda ? `${IDENTITY_GLYPH_BOX} text-[7px]` : 'h-5 w-5 text-[9px]';
  const marker = inBanda ? 'identity-glyph' : undefined;
  return org.logoUrl
    ? <img
        src={org.logoUrl}
        alt=""
        data-testid={marker}
        className={`${cls} flex-shrink-0 rounded-full object-cover`}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
      />
    // THE INITIALS ARE THE LOGO when there is no image, so they are content and
    // they have to READ. One indigo for both themes did not: `indigo-400` on
    // the tinted disc measured 4.46:1 in dark, which is a fail by four
    // hundredths and exactly the kind of miss an eye ratifies and a meter
    // catches. One step out per theme, away from the ground each sits on.
    : <span data-testid={marker} className={`${cls} flex flex-shrink-0 items-center justify-center rounded-full bg-indigo-500/20 font-bold text-indigo-700 dark:text-indigo-300`}>
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
    <span data-testid="identity-row-friends" className={SUBJECT}>
      <button
        ref={setChip}
        data-testid="identity-friends-chip"
        onClick={() => setAperto((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={aperto}
        // FULL when somebody is around, OUTLINED when nobody is: this is the
        // subject the whole "which of the three exist" question was about, and
        // it is now answered by the chip's own body instead of by a zero you
        // have to go and read.
        className={`${chipClass(ci_sono)} min-w-0 justify-center text-left`}
        title={ci_sono ? online.map((f) => f.nome).join(', ') : tr('statusBar.friends.title')}
      >
        <span data-testid="identity-glyph" className={`flex ${IDENTITY_GLYPH_BOX} flex-shrink-0 items-center justify-center ${ci_sono ? SEGNALE_OK : CHIP_INK_DIM}`}>
          <Users size={IDENTITY_GLYPH_INK} />
        </span>
        {ci_sono && <Facce facce={online} totale={online.length} />}
        {/* With people around the faces ARE the answer, so the chip drops the
            words and keeps two numbers: how many are here, out of how many you
            know. Alone, the chip says its own name instead, because a chip that
            is only a glyph and a zero is a door nobody recognises. */}
        {!ci_sono && (
          <span className={`truncate ${CHIP_INK_DIM}`}>{tr('statusBar.friends.title')}</span>
        )}
        {ci_sono && (
          <span className="flex-shrink-0 text-app-text-secondary tabular-nums">{online.length}</span>
        )}
        <span data-testid="identity-friends-total" className={`flex-shrink-0 ${CHIP_INK_DIM} tabular-nums`}>
          {ci_sono ? `/${totali}` : totali}
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
            <Azione onClick={() => { setAperto(false); apriProfilo('followers'); }} testId="friends-open-all">
              {tr('statusBar.friends.manage')}
            </Azione>
          </div>
        </PresencePopover>
      )}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * ONE SIGNAL: a glyph and a number, and the colour of its tier.
 *
 * The glyph is the noun ("sessions", "turns", "tasks") drawn instead of spelled:
 * in a chip that shares a 240px line with a name, a word costs six times what
 * the icon costs and says exactly the same thing. The `title` gives the word
 * back to whoever hovers, and to whoever reads with a screen reader.
 */
function Signal({ kind, n }: { kind: SignalKind; n: number }) {
  const tr = useT();
  const { Icon, tint, label, alive } = SIGNALS[kind];
  return (
    <span className={`flex items-center gap-0.5 ${tint}`} title={tr(label, { n })}>
      <Icon size={11} className={alive ? 'animate-pulse' : undefined} />
      <span>{n}</span>
    </span>
  );
}

/** Glyph, tier colour and sentence for each signal. One table, so a new signal
 *  is a line here and not a fourth place to keep in sync. */
const SIGNALS: Record<SignalKind, {
  Icon: typeof Bot;
  tint: string;
  label: string;
  alive?: boolean;
}> = {
  // The only pulsing one: it is the only one where something is happening
  // while you look at it.
  working: { Icon: Bot, tint: SEGNALE_OK, label: 'statusBar.signals.working', alive: true },
  awaitingInput: { Icon: Hourglass, tint: SEGNALE_ATTESA, label: 'statusBar.signals.awaitingInput' },
  done: { Icon: Hourglass, tint: TIER_DONE_TEXT, label: 'statusBar.signals.done' },
  tasks: { Icon: ListChecks, tint: 'text-app-text-secondary', label: 'statusBar.signals.tasks' },
  open: { Icon: MessagesSquare, tint: CHIP_INK_DIM, label: 'statusBar.signals.open' },
};

/**
 * THE LIST OF PEOPLE inside a panel: present on top, absent below.
 *
 * The two groups are separated by a label and not only by the colour of the
 * dot: the colour states one ROW, the label states where the group you are
 * scrolling ends, which is the information you need when the rows are twenty
 * and the first three are green.
 *
 * A CAP AND A SCROLL, not the whole list: an organisation with forty people
 * would make the panel taller than the window, and `computeMenuPosition` would
 * glue it to the edge. Seven rows and a half is the point where you can see
 * there is more below without the panel turning into a page.
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

/**
 * A PERSON IN A PANEL, and the panel is not where the story about them ends.
 *
 * This row used to be a `div`: a face, a name and a dot, and no way to get from
 * any of the three to the person. Every place a person appears has to open
 * their profile, otherwise there are faces the app shows you and refuses to
 * tell you anything about, and the profile page might as well not exist.
 */
function Persona({ p }: { p: RigaPresenza }) {
  return (
    <button
      type="button"
      onClick={() => openPersonProfile(p.id)}
      data-testid="presence-person"
      data-online={p.presente ? 'true' : 'false'}
      className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] hover:bg-app-hover coarse:min-h-11"
      title={p.nome}
    >
      <span className={`flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full ${p.presente ? '' : 'opacity-50'}`}>
        {p.avatarUrl
          ? <img src={p.avatarUrl} alt="" className="h-full w-full object-cover" />
          : <span className="flex h-full w-full items-center justify-center bg-primary/20 text-[8px] font-semibold leading-none text-app-text">
              {p.iniziali}
            </span>}
      </span>
      <span className={`truncate ${p.presente ? 'text-app-text' : 'text-app-text-muted'}`}>{p.nome}</span>
      <span
        className={`ml-auto h-1.5 w-1.5 flex-shrink-0 rounded-full ${p.presente ? PALLINO_OK : 'bg-app-text-muted/40'}`}
      />
    </button>
  );
}

/** A label/value pair in the identity panel. The label is what the closed row
 *  had no room to spell out. */
function Voce({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="flex-shrink-0 text-app-text-muted">{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-1 text-app-text-secondary">{children}</span>
    </div>
  );
}

/** The action row at the bottom of a panel: the link to the page that governs
 *  what the panel shows. The chevron says you are leaving here. */
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
            : <span className="flex h-full w-full items-center justify-center bg-primary/20 text-[7px] font-semibold leading-none text-app-text">
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
