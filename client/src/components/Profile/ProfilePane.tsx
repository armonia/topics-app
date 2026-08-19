import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { ProfilePage, OrganizationPage, FriendsPage } from '../Settings/IdentityPages';
import { IDENTITY_SECTIONS, SETTINGS_SECTIONS, type SectionId } from '../Settings/sections';

/**
 * Pane «Profilo» — la tab dedicata a chi sei, con chi stai e chi hai intorno.
 *
 * ── PERCHÉ UN PANE E NON SOLO UNA SCHEDA DELLE IMPOSTAZIONI ─────────────────
 * Le statistiche personali stavano solo dentro un modale: per vederle bisogna
 * aprire le preferenze, trovare la scheda e scorrere. Una cosa che si guarda
 * spesso merita una tab come Dashboard, non tre gesti dentro una finestra che
 * copre l'app.
 *
 * ── PERCHÉ TRE SOTTO-PAGINE E NON UNA COLONNA UNICA ─────────────────────────
 * Prima questo pane impilava quattro riquadri di fila — statistiche, Discord,
 * organizzazioni, amici — e chi cercava l'organizzazione doveva sapere che era
 * il terzo scorrendo. È lo stesso difetto che aveva il pannello Impostazioni, e
 * la cura è la stessa: tre pagine con un nome ciascuna. Le pagine sono
 * LETTERALMENTE quelle delle impostazioni (`Settings/IdentityPages`), così le
 * due superfici non possono divergere: quando lì è comparso l'account, qui
 * mancava, e nessuno se n'era accorto.
 */
export function ProfilePane() {
  const t = useT();
  const [pagina, setPagina] = useState<SectionId>('profile');

  return (
    <div data-testid="profile-pane" className="flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* Le tre voci SONO l'intestazione: non c'è un titolo di pane sopra che
          ripeta la parola «Profilo» mentre sei su «Amici». */}
      <div
        className="flex flex-shrink-0 items-center gap-1 overflow-x-auto overscroll-x-contain border-b border-app-border px-3 py-2"
        role="tablist"
        aria-label="Profilo"
      >
        {IDENTITY_SECTIONS.map((id) => {
          const voce = SETTINGS_SECTIONS.find((s) => s.id === id);
          if (!voce) return null;
          const Icon = voce.icon;
          const attiva = pagina === id;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={attiva}
              onClick={() => setPagina(id)}
              data-testid={`profile-tab-${id}`}
              className={`flex flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] transition-colors coarse:min-h-11 ${
                attiva
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-app-text-secondary hover:bg-app-hover hover:text-app-text'
              }`}
            >
              <Icon size={14} className="flex-shrink-0" />
              {t(voce.labelKey)}
            </button>
          );
        })}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 md:px-5">
        {pagina === 'profile' && <ProfilePage />}
        {pagina === 'organization' && <OrganizationPage />}
        {pagina === 'friends' && <FriendsPage />}
      </div>
    </div>
  );
}
