/**
 * Lo stato «chi sono» vive fuori da React, quindi si prova senza React.
 *
 * Il caso che conta è la DEDUPLICA: questo modulo notifica solo quando qualcosa
 * è davvero cambiato, e il confronto sbagliato non produce un errore rumoroso —
 * produce una schermata che resta com'era. È il modo peggiore in cui un difetto
 * si presenta, perché somiglia a «non è successo niente».
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  subscribeSession, markUnpaired, refreshSession, __resetSessionForTests, getSession,
} from './session';

const fetchVero = globalThis.fetch;

/** Fa rispondere `/api/auth/session` con quello che diciamo noi. */
function rispondi(corpo: Record<string, unknown>) {
  globalThis.fetch = (async () => new Response(JSON.stringify(corpo), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

function raccogli() {
  const visti: string[] = [];
  const stop = subscribeSession((s) => {
    visti.push(
      s.status === 'paired' ? `paired:${s.name}:${s.role}`
        : s.status === 'unpaired' ? `unpaired:${s.reason}`
          : 'loading',
    );
  });
  return { visti, stop };
}

describe('sessione · la notifica arriva quando cambia qualcosa che si guarda', () => {
  beforeEach(() => { __resetSessionForTests(); });

  it('chi si iscrive riceve subito lo stato corrente', () => {
    const { visti, stop } = raccogli();
    expect(visti).toEqual(['loading']);
    stop();
  });

  it('«mai entrato» e «revocato» sono due cartelli diversi, e il secondo arriva', () => {
    // Entrambi hanno status 'unpaired': confrontare solo lo stato avrebbe
    // lasciato a schermo la frase sbagliata — «autorizza questo dispositivo»
    // invece di «ti è stato tolto l'accesso».
    const { visti, stop } = raccogli();
    markUnpaired(undefined);
    markUnpaired('device_revoked');
    expect(visti).toEqual(['loading', 'unpaired:not_paired', 'unpaired:revoked']);
    stop();
  });

  it('lo stesso motivo due volte non risveglia nessuno', () => {
    const { visti, stop } = raccogli();
    markUnpaired('session_expired');
    markUnpaired('session_expired');
    expect(visti).toEqual(['loading', 'unpaired:expired']);
    stop();
  });

  it('il codice sconosciuto ricade su «mai entrato», non su «revocato»', () => {
    // Sbagliare verso qui vuol dire accusare il server di aver tolto un accesso
    // che non ha mai tolto.
    markUnpaired('qualcosa_che_non_conosciamo');
    const s = getSession();
    expect(s.status === 'unpaired' && s.reason).toBe('not_paired');
  });

  it('disiscriversi ferma le notifiche', () => {
    const { visti, stop } = raccogli();
    stop();
    markUnpaired(undefined);
    expect(visti).toEqual(['loading']);
  });
});

describe('sessione · il RUOLO cambia a parità di nome', () => {
  beforeEach(() => { __resetSessionForTests(); });
  afterEach(() => { globalThis.fetch = fetchVero; });

  it('da proprietario a ospite si propaga, anche se il nome è lo stesso', async () => {
    // È il difetto per cui questo file esiste. La delibera di prima confrontava
    // `status` e il solo `name`: qui i due sono identici, quindi il cambio
    // veniva scartato come «niente di nuovo» — e `SessionRoot` decide proprio
    // su `role` se montare l'app o la vista dell'ospite. Restava montata l'app
    // a chi non deve più vederla.
    rispondi({ paired: true, as: 'device', name: 'Mac', deviceId: 'd1', role: 'owner' });
    await refreshSession();
    const { visti, stop } = raccogli();

    rispondi({ paired: true, as: 'device', name: 'Mac', deviceId: 'd1', role: 'guest' });
    await refreshSession();

    expect(visti).toEqual(['paired:Mac:owner', 'paired:Mac:guest']);
    stop();
  });

  it('una risposta identica non risveglia nessuno', async () => {
    rispondi({ paired: true, as: 'device', name: 'Mac', deviceId: 'd1', role: 'owner' });
    await refreshSession();
    const { visti, stop } = raccogli();
    await refreshSession();
    expect(visti).toEqual(['paired:Mac:owner']);
    stop();
  });

  it('un server che non dice il ruolo vale OSPITE, non proprietario', async () => {
    // Il default prudente è quello con MENO poteri: assumere `owner` mostrerebbe
    // l'app intera a chi non deve vederla, e un server vecchio ne sarebbe
    // l'unico sintomo.
    rispondi({ paired: true, as: 'device', name: 'Ignoto', deviceId: 'd9' });
    await refreshSession();
    const s = getSession();
    expect(s.status === 'paired' && s.role).toBe('guest');
  });

  it('la rete giù non è «non appaiato»', async () => {
    globalThis.fetch = (async () => { throw new Error("rete giù"); }) as unknown as typeof fetch;
    await refreshSession();
    // Dire «non appaiato» qui manderebbe a riappaiare un dispositivo che sta
    // benissimo.
    expect(getSession().status).toBe('loading');
  });
});

describe('sessione · la persona viaggia con lo stato', () => {
  beforeEach(() => { __resetSessionForTests(); });
  afterEach(() => { globalThis.fetch = fetchVero; });

  it('la persona arriva e si propaga', async () => {
    rispondi({ paired: true, as: 'device', name: 'Mac', deviceId: 'd1', role: 'owner', personId: 'p1' });
    await refreshSession();
    const s = getSession();
    expect(s.status === 'paired' && s.personId).toBe('p1');
  });

  it('un cambio di PERSONA a parità di tutto il resto risveglia i sottoscrittori', async () => {
    // Stessa forma del difetto sul ruolo: se il confronto non guardasse
    // `personId`, spostare un dispositivo su un'altra persona non arriverebbe
    // a nessuno — e «di chi è» decide cosa vedi.
    rispondi({ paired: true, as: 'device', name: 'Mac', deviceId: 'd1', role: 'owner', personId: 'p1' });
    await refreshSession();
    const { visti, stop } = raccogli();
    rispondi({ paired: true, as: 'device', name: 'Mac', deviceId: 'd1', role: 'owner', personId: 'p2' });
    await refreshSession();
    expect(visti).toHaveLength(2);
    stop();
  });

  it('un server che non manda la persona non fa esplodere niente', async () => {
    rispondi({ paired: true, as: 'device', name: 'Mac', deviceId: 'd1', role: 'owner' });
    await refreshSession();
    const s = getSession();
    expect(s.status === 'paired' && s.personId).toBeNull();
  });
});

/**
 * ── WHICH Topics is asking to be authorised ─────────────────────────────────
 *
 * The installation name matters most to whoever is NOT yet anybody: the
 * pairing screen is the one asking for an act of trust, and it was the only
 * one unable to say on whose behalf. With a single installation the gap is
 * invisible; with two, "Authorise this device" is a question with no subject.
 */
describe('sessione · il nome dell’installazione arriva a chi deve mostrarlo', () => {
  beforeEach(() => { __resetSessionForTests(); });

  it('viaggia sullo stato di chi NON è appaiato, che è dove serve', async () => {
    rispondi({ paired: false, as: null, name: null, installationName: 'MacBook di Attilio' });
    await refreshSession();
    const s = getSession();
    expect(s.status === 'unpaired' && s.installationName).toBe('MacBook di Attilio');
  });

  it('un nome NUOVO a parità di motivo risveglia i sottoscrittori', async () => {
    // Same family of defect as role and person: if the comparison ignored the
    // name, the screen would keep showing the previous one. An equality that
    // ignores a field somebody paints is an update that never arrives.
    rispondi({ paired: false, as: null, name: null, installationName: 'Fisso in studio' });
    await refreshSession();
    const { visti, stop } = raccogli();
    rispondi({ paired: false, as: null, name: null, installationName: 'MacBook di Attilio' });
    await refreshSession();
    expect(visti).toHaveLength(2);
    stop();
  });

  it('un rifiuto qualunque non CANCELLA il nome già noto', async () => {
    // `api.ts` calls `markUnpaired` from the refusal of any request, which has
    // no name in it: clearing it there would wipe the heading off the screen on
    // the first 401, exactly when it is needed.
    rispondi({ paired: false, as: null, name: null, installationName: 'MacBook di Attilio' });
    await refreshSession();
    markUnpaired('device_revoked');
    const s = getSession();
    expect(s.status === 'unpaired' && s.reason).toBe('revoked');
    expect(s.status === 'unpaired' && s.installationName).toBe('MacBook di Attilio');
  });

  it('un server più vecchio che non lo manda non fa esplodere niente', async () => {
    // The screen stays quiet instead of painting a blank under the mark.
    rispondi({ paired: false, as: null, name: null });
    await refreshSession();
    const s = getSession();
    expect(s.status === 'unpaired' && s.installationName).toBeNull();
  });
});
