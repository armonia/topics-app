/**
 * LE TRE PAGINE DELL'IDENTITÀ, in un posto solo.
 *
 * Le stesse tre cose venivano disegnate in due punti — il pannello Impostazioni
 * e il pane «Profilo» standalone — e i due elenchi erano già divergenti:
 * l'account e i progetti dell'organizzazione comparivano solo nel pannello.
 * Due copie di una schermata sono due schermate che rispondono diversamente
 * alla stessa domanda; qui la fonte è una e i due host la mostrano.
 *
 * Ogni pagina ha un TITOLO e una riga che dice a cosa serve. Non è decorazione:
 * è ciò che distingue una pagina da un riquadro in mezzo a uno scorrimento —
 * quando apri «Organizzazione» devi leggere che sei nell'organizzazione, non
 * dedurlo da un elenco di nomi.
 */
import type { ReactNode } from 'react';
import { useT } from '../../hooks/useT';
import { ProfileStatsSection } from './ProfileStatsSection';
import { DiscordSection } from './DiscordSection';
import { AccountSection } from './AccountSection';
import { IdentitySection } from './IdentitySection';
import { OrgProjectsSection } from './OrgProjectsSection';
import { FriendsSection } from './FriendsSection';

function PageHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="border-b border-app-border pb-3">
      <h2 className="text-[15px] font-semibold text-app-text">{title}</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-app-text-secondary">{blurb}</p>
    </div>
  );
}

function Page({ testid, titleKey, blurbKey, children }: {
  testid: string;
  titleKey: string;
  blurbKey: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="space-y-6" data-testid={testid}>
      <PageHeader title={t(titleKey)} blurb={t(blurbKey)} />
      {children}
    </div>
  );
}

/** CHI SEI: le tue misure, lo stato che pubblichi fuori, l'account. */
export function ProfilePage() {
  return (
    <Page testid="settings-page-profile" titleKey="settings.page.profile.title" blurbKey="settings.page.profile.blurb">
      {/* Le statistiche aprono la pagina perché sono l'unica cosa che c'è
          SEMPRE: l'account può non essere configurato affatto. */}
      <ProfileStatsSection />
      {/* Lo stato pubblicato fuori viene subito dopo le misure che pubblica:
          è la stessa materia, vista da chi non è qui. */}
      <DiscordSection />
      <AccountSection />
    </Page>
  );
}

/** CON CHI STAI: il gruppo, le persone che ne fanno parte, i suoi progetti. */
export function OrganizationPage() {
  return (
    <Page
      testid="settings-page-organization"
      titleKey="settings.page.organization.title"
      blurbKey="settings.page.organization.blurb"
    >
      {/* `IdentitySection` gestisce le organizzazioni per intero: elenco da
          `/api/auth/orgs`, selettore quando sono più di uno, membri, ruoli,
          creazione e cancellazione. Non le mancava una funzione: le mancava
          una porta con scritto sopra dove porta. */}
      <IdentitySection />
      <OrgProjectsSection />
    </Page>
  );
}

/** CHI C'È INTORNO: le facce da GitHub e quanto lavora ciascuno. */
export function FriendsPage() {
  return (
    <Page testid="settings-page-friends" titleKey="settings.page.friends.title" blurbKey="settings.page.friends.blurb">
      <FriendsSection />
    </Page>
  );
}
