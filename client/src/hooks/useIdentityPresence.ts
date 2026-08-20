/**
 * CHI SEI, CON CHI STAI, CHI C'E' ADESSO — una fonte sola per le tre righe.
 *
 * Le tre righe in fondo alla sidebar fanno domande diverse ma leggono gli
 * STESSI dati: le organizzazioni, i loro membri con l'ultimo accesso, la
 * rubrica con le facce. Tre componenti che se li andassero a prendere per conto
 * proprio sarebbero tre giri di rete per lo stesso giro di rete, e tre istanti
 * diversi: la riga delle org direbbe «2 online» mentre quella degli amici ne
 * mostra tre, e nessuna delle due sarebbe sbagliata.
 *
 * QUANTO SPESSO. Un minuto, come faceva la riga dell'identita' prima di questo
 * hook: la soglia dell'online e' cinque minuti (`PRESENZA_MS`), quindi
 * ricontare piu' spesso non cambierebbe una faccia e costerebbe una fetch per
 * organizzazione. La finestra nascosta non chiede niente, ed e' la stessa
 * regola di `usePresenceSummary` e `useSystemStatus`.
 *
 * QUANDO IL SERVIZIO DEGLI ACCOUNT NON C'E'. Su un'installazione senza
 * organizzazioni queste rotte non rispondono: si resta senza righe invece di
 * mostrare degli zeri. «Non lo so» si dice tacendo, non con un numero inventato
 * — e' la stessa scelta gia' scritta in `orgPresence.ts`.
 */
import { useCallback, useEffect, useState } from 'react';
import { peopleApi, type PersonaConProfilo } from '@/lib/api';
import {
  facceOnline, unisciFacce, presentiOra,
  type FacciaPresenza, type MembroPresenza,
} from '@/components/Sidebar/orgPresence';

/** Un'organizzazione, con dentro chi c'e' adesso. */
export interface OrgConPresenza {
  id: string;
  nome: string;
  logoUrl: string | null;
  /** L'organizzazione di QUESTA installazione: e' quella che si mostra per prima. */
  installazione: boolean;
  /** Quanti ALTRI membri sono online adesso. */
  online: number;
  /** Quanti membri ha in tutto (te compreso): il denominatore di «2 di 7». */
  membri: number;
  /** Le facce di chi e' online, gia' ordinate. */
  facce: FacciaPresenza[];
}

export interface PresenzaIdentita {
  /** Le organizzazioni, quella dell'installazione per prima. */
  orgs: OrgConPresenza[];
  /** Chi e' online adesso, in tutte le tue organizzazioni, senza ripetizioni. */
  amiciOnline: FacciaPresenza[];
  /** Quante persone conosci in tutto, te esclusa. Il denominatore degli amici. */
  amiciTotali: number;
  /** Io, dalla rubrica: la faccia e il nome della prima riga. */
  io: PersonaConProfilo | null;
  /** `false` finche' il primo giro non e' tornato: le righe non lampeggiano. */
  pronto: boolean;
}

const VUOTO: PresenzaIdentita = { orgs: [], amiciOnline: [], amiciTotali: 0, io: null, pronto: false };

/** Ogni minuto: la soglia dell'online e' cinque, ricontare piu' spesso non
 *  cambia niente e costa una fetch per organizzazione. */
const INTERVALLO_MS = 60_000;

interface OrgApi {
  id: string;
  name: string;
  logo_url: string | null;
  installation?: boolean;
}

/** Quante organizzazioni si interrogano davvero. Oltre, la riga non le
 *  mostrerebbe comunque tutte e ogni org e' una fetch in piu'. */
const MAX_ORG = 8;

export function useIdentityPresence(enabled = true, intervalMs = INTERVALLO_MS): PresenzaIdentita {
  const [stato, setStato] = useState<PresenzaIdentita>(VUOTO);

  const leggi = useCallback(async () => {
    if (document.hidden) return;
    // La rubrica e le organizzazioni in parallelo: sono indipendenti, e in
    // serie la riga degli amici aspetterebbe la riga delle org per niente.
    const [rubricaRes, orgsRes] = await Promise.allSettled([
      peopleApi.list(),
      fetch('/api/auth/orgs', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)),
    ]);

    const rubrica: PersonaConProfilo[] = rubricaRes.status === 'fulfilled' ? rubricaRes.value.people : [];
    const io = rubrica.find((p) => p.isMe) ?? null;
    const orgsRaw: OrgApi[] = orgsRes.status === 'fulfilled' && orgsRes.value
      ? ((orgsRes.value as { orgs?: OrgApi[] }).orgs ?? [])
      : [];

    // L'organizzazione dell'installazione per prima, il resto in ordine
    // alfabetico: la tua e' quella che guardi, non quella che il database
    // restituisce per prima.
    const ordinate = [...orgsRaw]
      .sort((a, b) => Number(!!b.installation) - Number(!!a.installation) || a.name.localeCompare(b.name))
      .slice(0, MAX_ORG);

    const adesso = Date.now();
    const mioId = io?.id ?? null;
    const conMembri = await Promise.all(ordinate.map(async (o): Promise<OrgConPresenza> => {
      let membri: MembroPresenza[] = [];
      try {
        const r = await fetch(`/api/auth/orgs/${encodeURIComponent(o.id)}/members`, { credentials: 'same-origin' });
        if (r.ok) membri = ((await r.json()) as { members?: MembroPresenza[] }).members ?? [];
      } catch { /* org senza risposta: resta senza presenza, non sparisce */ }
      return {
        id: o.id,
        nome: o.name,
        logoUrl: o.logo_url ?? null,
        installazione: !!o.installation,
        online: presentiOra(membri, mioId, adesso),
        membri: membri.length,
        facce: facceOnline(membri, rubrica, mioId, adesso),
      };
    }));

    setStato({
      orgs: conMembri,
      amiciOnline: unisciFacce(conMembri.map((o) => o.facce)),
      // La rubrica E' l'elenco degli amici (le persone delle tue
      // organizzazioni): e' la stessa lista che apre la pagina «Amici», quindi
      // il numero qui e le righe la' non possono divergere.
      amiciTotali: rubrica.filter((p) => !p.isMe).length,
      io,
      pronto: true,
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let vivo = true;
    const giro = () => { if (vivo) void leggi(); };
    // Dopo il primo paint, non durante: in fondo alla sidebar nessuno di questi
    // numeri serve nel primo frame, e una scrittura di stato sincrona in
    // montaggio e' cio' che `set-state-in-effect` marca.
    const primo = setTimeout(giro, 0);
    const ogni = setInterval(giro, intervalMs);
    const alRitorno = () => { if (!document.hidden) giro(); };
    document.addEventListener('visibilitychange', alRitorno);
    // Un dispositivo appena appaiato cambia CHI SEI: aspettare il minuto
    // successivo vorrebbe dire mostrare l'identita' vecchia proprio nell'istante
    // in cui si guarda per verificare che l'appaiamento sia andato.
    window.addEventListener('topics:auth-pair-resolved', giro);
    window.addEventListener('topics:auth-device-revoked', giro);
    return () => {
      vivo = false;
      clearTimeout(primo);
      clearInterval(ogni);
      document.removeEventListener('visibilitychange', alRitorno);
      window.removeEventListener('topics:auth-pair-resolved', giro);
      window.removeEventListener('topics:auth-device-revoked', giro);
    };
  }, [enabled, intervalMs, leggi]);

  return stato;
}
