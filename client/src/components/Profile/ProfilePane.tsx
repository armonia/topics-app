import { UserRound } from 'lucide-react';
import { ProfileStatsSection } from '../Settings/ProfileStatsSection';
import { IdentitySection } from '../Settings/IdentitySection';
import { DiscordSection } from '../Settings/DiscordSection';
import { FriendsSection } from '../Settings/FriendsSection';

/**
 * Pane Profilo — la tab dedicata alle statistiche personali e all'identita'.
 *
 * Prima le statistiche stavano dentro Settings > Profilo (un pannello modale).
 * Erano raggiungibili solo aprendo il pannello impostazioni, navigando alla
 * scheda giusta e scorrendo. Il task chiedeva esplicitamente «una tab del
 * profilo, fondamentalmente» — un pane standalone come Dashboard, non una
 * sezione di un modal.
 *
 * Questo pane rende le stesse sezioni che stanno in Settings > Profilo, ma
 * come pane autonoma con la sua tab nell'app. L'originale in Settings resta:
 * e' ragionevole avere accesso alle statistiche anche dal pannello impostazioni.
 */
export function ProfilePane() {
  return (
    <div data-testid="profile-pane" className="flex flex-1 flex-col min-h-0 overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-app-border px-4 py-2 flex-shrink-0">
        <UserRound size={14} className="text-app-text-muted" />
        <span className="text-[13px] font-semibold text-app-text">Profilo</span>
      </div>

      {/* Content */}
      <div className="flex flex-col gap-6 px-4 py-4 md:px-5">
        <ProfileStatsSection />
        <DiscordSection />
        <IdentitySection />
        <FriendsSection />
      </div>
    </div>
  );
}
