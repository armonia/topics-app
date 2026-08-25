/**
 * The MEASURED entries: real megabytes, and the rule that keeps them readable.
 *
 * The fact worth pinning is not that the sum adds up — it is the AGGREGATION.
 * Twelve terminals make twelve rows, and twelve thirty-megabyte rows hide the
 * seven-hundred one: the inventory gets longer and less useful exactly as the
 * machine fills up, which is exactly when someone opens it.
 *
 * The other half is the floor: a group under one megabyte gets no row at all,
 * because "0 MB" is noise wearing the clothes of a measurement.
 *
 * @covers RES-ATTR-07
 */
import { describe, it, expect } from 'bun:test';
import { vociMisurate, type IngressiMisurati } from './featureUsage';

const vuoto: IngressiMisurati = {
  sessioni: [], browser: [], radici: [], scriptsMB: 0, scriptsProcessCount: 0,
};

describe('sessioni', () => {
  it('aggrega i terminali in UNA voce invece di dodici righe', () => {
    const v = vociMisurate({
      ...vuoto,
      sessioni: [
        { sessionId: 'a', name: 'claude', memoryMB: 396, processCount: 3 },
        { sessionId: 'b', name: 'shell', memoryMB: 30, processCount: 1 },
      ],
    });
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('fleet.sessions');
    expect(v[0].peso.memoryMB).toBe(426);
    expect(v[0].peso.processCount).toBe(4);
    expect(v[0].peso.entries).toBe(2);
  });

  it('nomina la sessione piu\' pesante nel dettaglio: e\' quella su cui si agisce', () => {
    const v = vociMisurate({
      ...vuoto,
      sessioni: [
        { sessionId: 'a', name: 'leggera', memoryMB: 30, processCount: 1 },
        { sessionId: 'b', name: 'pesante', memoryMB: 700, processCount: 2 },
      ],
    });
    expect(v[0].peso.detail?.piuPesante).toBe('pesante');
    expect(v[0].peso.detail?.mbDelPiuPesante).toBe(700);
  });

  it('una sessione senza nome ripiega sull\'id invece di una stringa vuota', () => {
    const v = vociMisurate({
      ...vuoto,
      sessioni: [{ sessionId: 'sess-123', name: '', memoryMB: 50, processCount: 1 }],
    });
    expect(v[0].peso.detail?.piuPesante).toBe('sess-123');
  });

  it('nessuna sessione, nessuna voce', () => {
    expect(vociMisurate(vuoto)).toEqual([]);
  });

  it('sessioni che sommano meno di 1 MB non fanno una riga da «0 MB»', () => {
    const v = vociMisurate({
      ...vuoto,
      sessioni: [{ sessionId: 'a', name: 'x', memoryMB: 0, processCount: 1 }],
    });
    expect(v).toEqual([]);
  });
});

describe('pannelli browser', () => {
  it('somma le webview in una voce, una per processo', () => {
    const v = vociMisurate({
      ...vuoto,
      browser: [
        { label: 'browserpane-1', memoryMB: 440 },
        { label: 'browserpane-2', memoryMB: 38 },
      ],
    });
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('shell.browserPanes');
    expect(v[0].peso.memoryMB).toBe(478);
    expect(v[0].peso.processCount).toBe(2);
  });
});

describe('radici del lato server', () => {
  it('ogni ponte ha la sua riga: sommarli direbbe cio\' che la barra gia\' dice', () => {
    const v = vociMisurate({
      ...vuoto,
      radici: [
        { kind: 'server', memoryMB: 372, processCount: 1 },
        { kind: 'pty-bridge', memoryMB: 21, processCount: 1 },
        { kind: 'ai-bridge', memoryMB: 68, processCount: 1 },
      ],
    });
    expect(v.map(x => x.id)).toEqual([
      'fleet.root.server', 'fleet.root.pty-bridge', 'fleet.root.ai-bridge',
    ]);
  });

  it('usa nomi che l\'utente riconosce, non il `kind` tecnico', () => {
    const v = vociMisurate({ ...vuoto, radici: [{ kind: 'pty-bridge', memoryMB: 21, processCount: 1 }] });
    expect(v[0].label).toBe('Ponte dei terminali');
  });

  it('un `kind` sconosciuto passa cosi\' com\'e\' invece di sparire', () => {
    const v = vociMisurate({ ...vuoto, radici: [{ kind: 'ponte-nuovo', memoryMB: 40, processCount: 1 }] });
    expect(v[0].label).toBe('ponte-nuovo');
  });

  it('una radice sotto il megabyte non fa riga', () => {
    const v = vociMisurate({ ...vuoto, radici: [{ kind: 'server', memoryMB: 0, processCount: 1 }] });
    expect(v).toEqual([]);
  });
});

describe('script degli agenti', () => {
  it('hanno una riga propria: spiegano un numero che si gonfia all\'improvviso', () => {
    const v = vociMisurate({ ...vuoto, scriptsMB: 700, scriptsProcessCount: 4 });
    expect(v).toHaveLength(1);
    expect(v[0].id).toBe('fleet.scripts');
    expect(v[0].peso.memoryMB).toBe(700);
    expect(v[0].peso.processCount).toBe(4);
  });

  it('nessuno script in corso, nessuna riga', () => {
    expect(vociMisurate({ ...vuoto, scriptsMB: 0, scriptsProcessCount: 0 })).toEqual([]);
  });
});

describe('ogni voce prodotta e\' MISURATA', () => {
  it('nessuna voce di questo modulo puo\' essere trattenuta', () => {
    const v = vociMisurate({
      sessioni: [{ sessionId: 'a', name: 'x', memoryMB: 50, processCount: 1 }],
      browser: [{ label: 'b', memoryMB: 40 }],
      radici: [{ kind: 'server', memoryMB: 300, processCount: 1 }],
      scriptsMB: 90, scriptsProcessCount: 2,
    });
    expect(v.length).toBe(4);
    expect(v.every(x => x.natura === 'misurato')).toBe(true);
    // E ognuna porta MB veri: una voce misurata senza MB sarebbe uno zero che
    // sembra una misura.
    expect(v.every(x => (x.peso.memoryMB ?? 0) > 0)).toBe(true);
  });
});
