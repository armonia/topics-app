import { describe, expect, it } from 'bun:test';
import {
  BANNER_CLAIM_KEY,
  bannerClaimKey,
  claimBannerIn,
  parseLedger,
  type ClaimStorage,
} from './messageBannerClaim';

/** Uno storage vero quanto basta: una mappa. Rappresenta il `localStorage`
 *
 * @covers MUTE-01
 *  CONDIVISO fra le finestre, quindi due "finestre" del test lo condividono. */
function sharedStorage(): ClaimStorage & { raw(): string | null } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    raw: () => m.get(BANNER_CLAIM_KEY) ?? null,
  };
}

const NOW = 1_700_000_000_000;

describe('claimBannerIn — due finestre, un messaggio', () => {
  it('la prima si prende la consegna, la seconda tace', () => {
    const s = sharedStorage();
    expect(claimBannerIn(s, 'msg-1', 'winA', NOW)).toBe(true);
    expect(claimBannerIn(s, 'msg-1', 'winB', NOW)).toBe(false);
  });

  it('tre finestre: una sola parla', () => {
    const s = sharedStorage();
    const fired = ['winA', 'winB', 'winC'].filter((w) => claimBannerIn(s, 'msg-1', w, NOW));
    expect(fired).toEqual(['winA']);
  });

  it('messaggi diversi non si rubano la consegna a vicenda', () => {
    const s = sharedStorage();
    expect(claimBannerIn(s, 'msg-1', 'winA', NOW)).toBe(true);
    expect(claimBannerIn(s, 'msg-2', 'winB', NOW)).toBe(true);
  });

  it('la stessa finestra non consegna due volte lo stesso messaggio', () => {
    // Un frame ri-annunciato (riconnessione, bootstrap che rigioca lo snapshot)
    // non deve poter ri-bannerizzare.
    const s = sharedStorage();
    expect(claimBannerIn(s, 'msg-1', 'winA', NOW)).toBe(true);
    expect(claimBannerIn(s, 'msg-1', 'winA', NOW)).toBe(false);
  });
});

describe('claimBannerIn — la corsa che la lettura di ritorno risolve', () => {
  it('due scritture intrecciate producono comunque UN solo vincitore', () => {
    // Lo scenario esatto: entrambe leggono "libero" prima che l'altra scriva,
    // quindi entrambe scrivono. Senza la rilettura, entrambe crederebbero di
    // aver vinto. Qui B scrive DENTRO la setItem di A, cioè fra la scrittura di
    // A e la sua rilettura — il peggior intreccio possibile.
    const s = sharedStorage();
    let interleaved = false;
    const hostile: ClaimStorage = {
      getItem: (k) => s.getItem(k),
      setItem: (k, v) => {
        s.setItem(k, v);
        if (!interleaved) {
          interleaved = true;
          // B parte da uno snapshot vuoto (aveva già letto "libero") e
          // sovrascrive la riga di A con la propria.
          s.setItem(BANNER_CLAIM_KEY, JSON.stringify([{ k: 'msg-1', c: 'winB', t: NOW }]));
        }
      },
    };
    // A crede di aver scritto, ma rileggendo trova B: tace.
    expect(claimBannerIn(hostile, 'msg-1', 'winA', NOW)).toBe(false);
    // E B, che ha scritto per ultima, trova sé stessa quando rilegge.
    expect(s.raw()).toContain('winB');
  });

  it('se la riga sparisce del tutto si consegna (in dubbio si suona)', () => {
    // Uno scrittore concorrente su un ALTRO messaggio può cancellare la nostra
    // riga partendo da uno snapshot vecchio. Che la chiave sia sparita significa
    // che nessuno la sta reclamando: tacere qui perderebbe il banner.
    const s = sharedStorage();
    const clobbering: ClaimStorage = {
      getItem: (k) => s.getItem(k),
      setItem: (k, v) => {
        s.setItem(k, v);
        s.setItem(BANNER_CLAIM_KEY, JSON.stringify([{ k: 'altro-msg', c: 'winC', t: NOW }]));
      },
    };
    expect(claimBannerIn(clobbering, 'msg-1', 'winA', NOW)).toBe(true);
  });
});

describe('claimBannerIn — in dubbio si suona', () => {
  it('storage illeggibile → consegna', () => {
    const broken: ClaimStorage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => {},
    };
    expect(claimBannerIn(broken, 'msg-1', 'winA', NOW)).toBe(true);
  });

  it('storage non scrivibile (quota) → consegna', () => {
    const full: ClaimStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    expect(claimBannerIn(full, 'msg-1', 'winA', NOW)).toBe(true);
  });

  it('registro corrotto → si riparte da zero, non si tace', () => {
    const s = sharedStorage();
    s.setItem(BANNER_CLAIM_KEY, '{non json');
    expect(claimBannerIn(s, 'msg-1', 'winA', NOW)).toBe(true);
  });
});

describe('parseLedger', () => {
  it('scarta le righe scadute e tiene le fresche', () => {
    const raw = JSON.stringify([
      { k: 'vecchia', c: 'w', t: NOW - 6 * 60_000 },
      { k: 'fresca', c: 'w', t: NOW - 60_000 },
    ]);
    expect(parseLedger(raw, NOW).map((e) => e.k)).toEqual(['fresca']);
  });

  it('una riga scaduta libera di nuovo la chiave', () => {
    const s = sharedStorage();
    expect(claimBannerIn(s, 'msg-1', 'winA', NOW)).toBe(true);
    expect(claimBannerIn(s, 'msg-1', 'winB', NOW + 6 * 60_000)).toBe(true);
  });

  it('un orologio spostato all indietro non riapre le consegne fatte', () => {
    // `now - t` negativo non è "scaduta": tenerla è l'unico comportamento che
    // non trasforma un cambio d'ora in una raffica di banner ripetuti.
    const raw = JSON.stringify([{ k: 'msg-1', c: 'w', t: NOW + 3 * 60_000 }]);
    expect(parseLedger(raw, NOW).map((e) => e.k)).toEqual(['msg-1']);
  });

  it('tollera qualunque forma sbagliata', () => {
    expect(parseLedger(null, NOW)).toEqual([]);
    expect(parseLedger('', NOW)).toEqual([]);
    expect(parseLedger('{non json', NOW)).toEqual([]);
    expect(parseLedger('{"k":"x"}', NOW)).toEqual([]);
    expect(parseLedger(JSON.stringify([null, 3, 'x', { k: 1, c: 2, t: 3 }]), NOW)).toEqual([]);
  });

  it('il registro non cresce senza fine', () => {
    const s = sharedStorage();
    for (let i = 0; i < 260; i++) claimBannerIn(s, `msg-${i}`, 'winA', NOW);
    expect(parseLedger(s.raw(), NOW).length).toBe(200);
    // Le più vecchie cadono, le recenti restano protette.
    expect(claimBannerIn(s, 'msg-259', 'winB', NOW)).toBe(false);
  });
});

describe('bannerClaimKey', () => {
  it('usa il messageId quando c è', () => {
    expect(bannerClaimKey({ messageId: 'm-7', topicId: 't', role: 'assistant' })).toBe('m-7');
  });

  it('senza messageId (server vecchio) ripiega su topic+ruolo+corpo', () => {
    const a = bannerClaimKey({ topicId: 't1', role: 'assistant', content: 'ciao' });
    const b = bannerClaimKey({ topicId: 't1', role: 'assistant', preview: 'ciao' });
    expect(a).toBe(b);
    expect(a).toBe('t1:assistant:ciao');
  });

  it('il ripiego distingue topic diversi e corpi diversi', () => {
    const k = (o: Parameters<typeof bannerClaimKey>[0]) => bannerClaimKey(o);
    expect(k({ topicId: 't1', role: 'assistant', content: 'a' }))
      .not.toBe(k({ topicId: 't2', role: 'assistant', content: 'a' }));
    expect(k({ topicId: 't1', role: 'assistant', content: 'a' }))
      .not.toBe(k({ topicId: 't1', role: 'assistant', content: 'b' }));
  });

  it('il ripiego dedup-a comunque due finestre sullo stesso frame legacy', () => {
    const s = sharedStorage();
    const frame = { topicId: 't1', role: 'assistant', preview: 'stessa cosa' };
    expect(claimBannerIn(s, bannerClaimKey(frame), 'winA', NOW)).toBe(true);
    expect(claimBannerIn(s, bannerClaimKey(frame), 'winB', NOW)).toBe(false);
  });
});
