/**
 * The downloads model behind the pane's toolbar menu: a start opens one entry,
 * a repeated poll does not duplicate it, a done closes or fails its own entry,
 * progress only moves a live one, and dismissing the last entry empties the list.
 *
 * @covers BROWSER-CHAT-02
 */
import { describe, expect, test } from 'bun:test';
import {
  applyDownloadEvent,
  activeCount,
  capDownloads,
  displayName,
  formatSize,
  formatProgress,
  downloadPercent,
  applyDownloadProgress,
  MAX_DOWNLOAD_ENTRIES,
  type DownloadEntry,
  type DownloadEventIn,
} from './downloadsModel';

function ev(over: Partial<DownloadEventIn> = {}): DownloadEventIn {
  return {
    kind: 'start',
    id: '1',
    url: 'https://example.com/files/report.zip',
    filename: 'report.zip',
    success: false,
    state: 'progressing',
    savedPath: '/Users/x/Downloads/report.zip',
    ...over,
  };
}

describe('applyDownloadEvent', () => {
  test('lo start apre una voce in corso, in testa', () => {
    const list = applyDownloadEvent([], ev());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: '1', filename: 'report.zip', state: 'progressing' });
  });

  test('lo stesso start due volte NON duplica la voce (il poll può ripassare)', () => {
    const once = applyDownloadEvent([], ev());
    const twice = applyDownloadEvent(once, ev());
    expect(twice).toHaveLength(1);
  });

  test('il done chiude la SUA voce, senza toccarne altre', () => {
    let list = applyDownloadEvent([], ev({ id: '1' }));
    list = applyDownloadEvent(list, ev({ id: '2', filename: 'altro.pdf' }));
    list = applyDownloadEvent(list, ev({ kind: 'done', id: '1', success: true, state: 'completed', savedPath: '/Users/x/Downloads/report (1).zip' }));
    expect(list.find((d) => d.id === '1')).toMatchObject({ state: 'completed', savedPath: '/Users/x/Downloads/report (1).zip' });
    expect(list.find((d) => d.id === '2')!.state).toBe('progressing');
  });

  test('il done fallito diventa uno stato visibile, non un silenzio', () => {
    let list = applyDownloadEvent([], ev({ id: '7' }));
    list = applyDownloadEvent(list, ev({ kind: 'done', id: '7', success: false, state: 'interrupted' }));
    expect(list[0].state).toBe('interrupted');
  });

  test('un done ORFANO (pane ricreata fra i due eventi) crea comunque la voce', () => {
    const list = applyDownloadEvent([], ev({ kind: 'done', id: '9', success: true, state: 'completed' }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: '9', state: 'completed', filename: 'report.zip' });
  });

  test('la voce NON scade da sola: dopo il done resta finché non la togli', () => {
    let list = applyDownloadEvent([], ev({ id: '3' }));
    list = applyDownloadEvent(list, ev({ kind: 'done', id: '3', success: true, state: 'completed' }));
    // nessun timer, nessuna scadenza: la lista è ancora lì
    expect(list).toHaveLength(1);
    expect(list.filter((d) => d.id !== '3')).toHaveLength(0);
  });
});

describe('capDownloads', () => {
  test('taglia le voci CHIUSE più vecchie', () => {
    const list: DownloadEntry[] = Array.from({ length: MAX_DOWNLOAD_ENTRIES + 3 }, (_, i) => ({
      id: String(i), url: 'u', filename: `f${i}`, state: 'completed',
    }));
    const out = capDownloads(list);
    expect(out).toHaveLength(MAX_DOWNLOAD_ENTRIES);
    expect(out[0].id).toBe('0'); // la più recente (in testa) sopravvive
  });

  test('un download IN CORSO non viene mai buttato via, nemmeno oltre il tetto', () => {
    const list: DownloadEntry[] = Array.from({ length: MAX_DOWNLOAD_ENTRIES + 2 }, (_, i) => ({
      id: String(i), url: 'u', filename: `f${i}`, state: 'progressing',
    }));
    expect(capDownloads(list)).toHaveLength(MAX_DOWNLOAD_ENTRIES + 2);
  });
});

describe('displayName', () => {
  test('preferisce il nome dato dal Rust (che viene da Content-Disposition)', () => {
    expect(displayName({ filename: 'report-2026.zip', url: 'https://x.dev/files?id=42' })).toBe('report-2026.zip');
  });

  test('senza nome ripiega sul path salvato, poi sull\'URL, e non è mai vuoto', () => {
    expect(displayName({ savedPath: '/Users/x/Downloads/a b.pdf' })).toBe('a b.pdf');
    expect(displayName({ url: 'https://x.dev/files/a%20b.pdf' })).toBe('a b.pdf');
    expect(displayName({ url: 'https://x.dev/' })).toBe('download');
    expect(displayName({})).toBe('download');
  });
});

describe('activeCount / formatSize', () => {
  test('conta solo quelli in corso', () => {
    const list: DownloadEntry[] = [
      { id: '1', url: 'u', filename: 'a', state: 'progressing' },
      { id: '2', url: 'u', filename: 'b', state: 'completed' },
      { id: '3', url: 'u', filename: 'c', state: 'progressing' },
    ];
    expect(activeCount(list)).toBe(2);
  });

  test('la dimensione manca ⇒ nessuna riga, non «0 B»', () => {
    expect(formatSize(undefined)).toBeUndefined();
    expect(formatSize(-1)).toBeUndefined();
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(4096)).toBe('4 KB');
    expect(formatSize(1_572_864)).toBe('1.5 MB');
  });
});

describe('avanzamento', () => {
  const progressing: DownloadEntry = { id: '1', url: 'u', filename: 'a.zip', state: 'progressing' };

  test('la misura entra nella voce in corso', () => {
    const out = applyDownloadProgress([progressing], [{ id: '1', received: 500, total: 1000 }]);
    expect(out[0].received).toBe(500);
    expect(out[0].total).toBe(1000);
  });

  test('una voce FINITA non si tocca: i byte sul disco non sono piu\' un avanzamento', () => {
    const list: DownloadEntry[] = [{ ...progressing, state: 'completed' }];
    const out = applyDownloadProgress(list, [{ id: '1', received: 999, total: 1000 }]);
    expect(out[0].received).toBeUndefined();
    expect(out).toBe(list);
  });

  test('misura di un id sconosciuto: scartata, non diventa una riga', () => {
    const list = [progressing];
    const out = applyDownloadProgress(list, [{ id: 'altro', received: 10, total: 20 }]);
    expect(out).toHaveLength(1);
    expect(out[0].received).toBeUndefined();
    expect(out).toBe(list);
  });

  test('niente di nuovo ⇒ STESSA lista, cosi\' il menu non si ridisegna', () => {
    const list = [{ ...progressing, received: 500, total: 1000 }];
    expect(applyDownloadProgress(list, [{ id: '1', received: 500, total: 1000 }])).toBe(list);
    expect(applyDownloadProgress(list, [])).toBe(list);
  });

  test('i valori negativi del Rust valgono «non lo so»: si tiene il vecchio', () => {
    const list = [{ ...progressing, received: 500, total: 1000 }];
    const out = applyDownloadProgress(list, [{ id: '1', received: -1, total: -1 }]);
    expect(out[0].received).toBe(500);
    expect(out[0].total).toBe(1000);
  });

  test('la percentuale esiste solo con un totale vero', () => {
    expect(downloadPercent({ received: 500, total: 1000 })).toBe(50);
    expect(downloadPercent({ received: 0, total: 1000 })).toBe(0);
    expect(downloadPercent({ received: 500, total: undefined })).toBeUndefined();
    expect(downloadPercent({ received: undefined, total: 1000 })).toBeUndefined();
    expect(downloadPercent({ received: 500, total: 0 })).toBeUndefined();
    expect(downloadPercent({ received: 500, total: -1 })).toBeUndefined();
  });

  test('arrotonda per DIFETTO e non esce mai da 0..100', () => {
    // 999/1000 e' 99,9%: mostrarlo come 100% farebbe sembrare fermo un download
    // che sta ancora scrivendo.
    expect(downloadPercent({ received: 999, total: 1000 })).toBe(99);
    // Il file sul disco puo' superare il totale STIMATO dall'xattr: la barra si
    // ferma a 100 invece di sfondare.
    expect(downloadPercent({ received: 1200, total: 1000 })).toBe(100);
  });

  test('il dettaglio dice i byte, e il totale solo quando c\'e\'', () => {
    expect(formatProgress({ received: 1_572_864, total: 3_145_728 })).toBe('1.5 MB di 3 MB');
    expect(formatProgress({ received: 1_572_864, total: undefined })).toBe('1.5 MB');
    expect(formatProgress({ received: undefined, total: 1000 })).toBeUndefined();
  });
});
