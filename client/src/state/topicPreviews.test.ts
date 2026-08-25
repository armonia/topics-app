/**
 * @covers TOPIC-PREVIEW-01
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  applyMessagePreview,
  cleanPreviewText,
  clearTopicPreview,
  getTopicPreview,
  subscribeTopicPreview,
  TOPIC_PREVIEW_MAX,
  TOPIC_PREVIEW_SOURCE_MAX,
  __resetTopicPreviews,
} from './topicPreviews';

/**
 * Due contratti, e nessuno dei due è "il testo giusto".
 *
 * Il primo è la POTATURA: sotto al nome di una chat c'è una riga da 11px, e ciò
 * che ci finisce deve essere prosa — un blocco di codice o un `#` a inizio riga
 * la sprecano tutta. Il secondo, e conta di più, è CHI SI SVEGLIA: la sidebar ha
 * N righe, e un messaggio su una chat non deve poter ri-renderizzare le altre.
 * Le asserzioni sui contatori degli iscritti sono la parte vera del file.
 */

beforeEach(() => {
  __resetTopicPreviews();
});

describe('cleanPreviewText — potatura', () => {
  test('un blocco di codice sparisce, la frase che lo introduceva resta', () => {
    const raw = 'Ecco la patch:\n```ts\nconst x = 1;\nconst y = 2;\n```\nProvala.';
    expect(cleanPreviewText(raw)).toBe('Ecco la patch: Provala.');
  });

  test('la recinzione APERTA (turno tagliato a metà) si porta via la coda', () => {
    expect(cleanPreviewText('Guarda qui:\n```sh\nrm -rf /tmp/x')).toBe('Guarda qui:');
  });

  test('niente a-capo: il testo diventa UNA riga e gli spazi si comprimono', () => {
    const out = cleanPreviewText('prima riga\n\n   seconda   riga\t\tterza');
    expect(out).toBe('prima riga seconda riga terza');
    expect(out).not.toContain('\n');
  });

  test('via i marcatori di struttura, ma NON gli underscore delle parole', () => {
    expect(cleanPreviewText('## Titolo\n- primo\n1. secondo\n> citato')).toBe(
      'Titolo primo secondo citato',
    );
    // Se `__` sparisse, `mcp__topics__browser` diventerebbe una parola diversa.
    expect(cleanPreviewText('ho chiamato mcp__topics__browser_navigate su session_key')).toBe(
      'ho chiamato mcp__topics__browser_navigate su session_key',
    );
  });

  test('grassetto e corsivo via, una moltiplicazione resta una moltiplicazione', () => {
    expect(cleanPreviewText('**fatto** in *fretta*')).toBe('fatto in fretta');
    expect(cleanPreviewText('conta 2 * 3 * 4 celle')).toBe('conta 2 * 3 * 4 celle');
  });

  test('link ridotto alla sua etichetta, immagine via, backtick via', () => {
    expect(cleanPreviewText('vedi [il report](https://esempio.test/x?y=1) e `foo.ts`')).toBe(
      'vedi il report e foo.ts',
    );
    expect(cleanPreviewText('![grafico](/media/a.png) ecco')).toBe('ecco');
  });

  test('una riga orizzontale non diventa il primo carattere che si legge', () => {
    expect(cleanPreviewText('fatto\n---\ndettagli')).toBe('fatto dettagli');
  });

  test('l’impalcatura iniettata non è un messaggio', () => {
    expect(cleanPreviewText('<system-reminder>non dirlo</system-reminder> ciao')).toBe('ciao');
  });

  test('un messaggio di solo codice non lascia niente', () => {
    expect(cleanPreviewText('```\nrm -rf /\n```')).toBe('');
  });
});

/**
 * Il tetto sul GREZZO. Il server tronca a 600 caratteri prima di mandare; il WS
 * no, e di lì passa il `content` intero — 158.122 caratteri per il messaggio più
 * lungo dell'archivio, dieci regex sopra, in ogni finestra aperta. Il taglio sta
 * davanti alle regex, quindi il test che conta è che per i testi CORTI non
 * cambi niente: il resto del file lo verifica caso per caso, qui si fissa il
 * confine.
 */
describe('cleanPreviewText — tetto sul testo grezzo', () => {
  test('sotto il tetto non cambia niente rispetto a prima', () => {
    const corto = 'x '.repeat(100).trim(); // 199 caratteri, ben sotto i 600
    expect(cleanPreviewText(corto)).toBe(cleanPreviewText(corto.slice(0, TOPIC_PREVIEW_SOURCE_MAX)));
    expect(cleanPreviewText('ok, fatto')).toBe('ok, fatto');
  });

  test('un mostro da 158k dà lo STESSO risultato dei suoi primi 600 caratteri', () => {
    const mostro = 'Ecco il resoconto: ' + 'parola '.repeat(22_000);
    expect(mostro.length).toBeGreaterThan(150_000);
    expect(cleanPreviewText(mostro)).toBe(cleanPreviewText(mostro.slice(0, TOPIC_PREVIEW_SOURCE_MAX)));
  });

  test('quello che il taglio compra: le regex non vedono più di 600 caratteri', () => {
    // Un blocco di codice APERTO lungo un chilometro è il caso peggiore per
    // `/```[\s\S]*$/`. Se il taglio non ci fosse, la regex percorrerebbe tutto.
    const mostro = 'Guarda:\n```\n' + 'a'.repeat(200_000);
    expect(cleanPreviewText(mostro)).toBe('Guarda:');
  });
});

describe('cleanPreviewText — troncamento', () => {
  test('taglia a TOPIC_PREVIEW_MAX con i puntini, senza superarlo', () => {
    const out = cleanPreviewText('a'.repeat(500));
    expect(out.length).toBe(TOPIC_PREVIEW_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  test('un testo corto non viene toccato', () => {
    expect(cleanPreviewText('ok')).toBe('ok');
  });

  test('è IDEMPOTENTE: il client ripassa sul testo già potato dal server', () => {
    const once = cleanPreviewText('Ecco:\n```js\nfoo()\n```\n' + 'parola '.repeat(60));
    expect(cleanPreviewText(once)).toBe(once);
  });
});

describe('applyMessagePreview', () => {
  test('registra testo, ruolo e istante del topic giusto', () => {
    applyMessagePreview('t1', 'user', 'ci sono?', 1000);
    expect(getTopicPreview('t1')).toEqual({ text: 'ci sono?', role: 'user', at: 1000 });
    expect(getTopicPreview('t2')).toBeUndefined();
  });

  test('un messaggio nuovo sostituisce il precedente', () => {
    applyMessagePreview('t1', 'user', 'ci sono?', 1000);
    applyMessagePreview('t1', 'assistant', 'eccomi', 2000);
    expect(getTopicPreview('t1')).toEqual({ text: 'eccomi', role: 'assistant', at: 2000 });
  });

  test('un frame più VECCHIO non vince (idratazione che atterra dopo il WS)', () => {
    applyMessagePreview('t1', 'assistant', 'eccomi', 2000);
    applyMessagePreview('t1', 'user', 'ci sono?', 1000);
    expect(getTopicPreview('t1')?.text).toBe('eccomi');
  });

  test('un messaggio senza prosa non cancella l’anteprima buona', () => {
    applyMessagePreview('t1', 'assistant', 'eccomi', 1000);
    applyMessagePreview('t1', 'assistant', '```\nls -la\n```', 2000);
    expect(getTopicPreview('t1')?.text).toBe('eccomi');
  });

  test('le buste di contesto di OpenClaw non sono messaggi', () => {
    applyMessagePreview('t1', 'user', '[Chat messages since your last reply] tre nuovi', 1000);
    expect(getTopicPreview('t1')).toBeUndefined();
  });

  test('identità stabile: due volte lo stesso messaggio, stesso oggetto', () => {
    applyMessagePreview('t1', 'assistant', 'eccomi', 1000);
    const first = getTopicPreview('t1');
    applyMessagePreview('t1', 'assistant', 'eccomi', 3000);
    expect(getTopicPreview('t1')).toBe(first!);
  });
});

describe('clearTopicPreview — «Svuota chat»', () => {
  test('toglie l’anteprima e lascia in pace le altre chat', () => {
    applyMessagePreview('t1', 'assistant', 'eccomi', 1000);
    applyMessagePreview('t2', 'assistant', 'anch’io', 1000);
    clearTopicPreview('t1');
    expect(getTopicPreview('t1')).toBeUndefined();
    expect(getTopicPreview('t2')?.text).toBe('anch’io');
  });

  test('sveglia l’iscritto di QUEL topic, e nessun altro', () => {
    let sveglieT1 = 0;
    let sveglieT2 = 0;
    subscribeTopicPreview('t1', () => { sveglieT1++; });
    subscribeTopicPreview('t2', () => { sveglieT2++; });
    applyMessagePreview('t1', 'assistant', 'eccomi', 1000);
    clearTopicPreview('t1');
    expect(sveglieT1).toBe(2);
    expect(sveglieT2).toBe(0);
  });

  test('su una chat senza anteprima non costa un render', () => {
    let sveglie = 0;
    subscribeTopicPreview('t1', () => { sveglie++; });
    clearTopicPreview('t1');
    expect(sveglie).toBe(0);
  });

  test('dopo lo svuotamento il primo messaggio nuovo riparte da zero', () => {
    // Il frame più vecchio non deve poter vincere sul nuovo: `at` è ripartito,
    // non c'è più un `prev` da confrontare.
    applyMessagePreview('t1', 'assistant', 'vecchio', 5000);
    clearTopicPreview('t1');
    applyMessagePreview('t1', 'user', 'riparto', 1000);
    expect(getTopicPreview('t1')).toEqual({ text: 'riparto', role: 'user', at: 1000 });
  });
});

describe('sottoscrizioni — chi si sveglia', () => {
  test('l’iscritto di un topic non sente i messaggi degli altri', () => {
    let sveglieT1 = 0;
    let sveglieT2 = 0;
    subscribeTopicPreview('t1', () => { sveglieT1++; });
    subscribeTopicPreview('t2', () => { sveglieT2++; });

    applyMessagePreview('t1', 'assistant', 'primo', 1000);
    expect(sveglieT1).toBe(1);
    expect(sveglieT2).toBe(0);

    applyMessagePreview('t2', 'assistant', 'secondo', 1000);
    expect(sveglieT1).toBe(1);
    expect(sveglieT2).toBe(1);
  });

  test('un messaggio IDENTICO ri-annunciato non costa un render', () => {
    let sveglie = 0;
    subscribeTopicPreview('t1', () => { sveglie++; });
    applyMessagePreview('t1', 'assistant', 'eccomi', 1000);
    applyMessagePreview('t1', 'assistant', 'eccomi', 2000);
    applyMessagePreview('t1', 'assistant', 'eccomi\n\n', 3000);
    expect(sveglie).toBe(1);
  });

  test('disiscriversi stacca davvero', () => {
    let sveglie = 0;
    const off = subscribeTopicPreview('t1', () => { sveglie++; });
    applyMessagePreview('t1', 'assistant', 'primo', 1000);
    off();
    applyMessagePreview('t1', 'assistant', 'secondo', 2000);
    expect(sveglie).toBe(1);
  });
});

describe("cleanPreviewText — IDEMPOTENTE davvero", () => {
  // Il patto con la gemella lato server: il testo che arriva dal WS fa UNA
  // passata di potatura, quello dell'idratazione ne fa DUE (il server ha già
  // pulito). Se la seconda passata cambia il risultato, la stessa chat mostra
  // due testi diversi prima e dopo un ricarico — la divergenza che questo store
  // esiste per non avere.
  for (const [nome, grezzo] of [
    ["citazione impilata", "> > citato"],
    ["elenco dentro elenco", "- - voce"],
    ["titoli impilati", "## # titolo"],
    ["numerata doppia", "1. 2. voce"],
    ["misto", "> - # roba"],
  ] as const) {
    test(`${nome}: una passata = due passate`, () => {
      const una = cleanPreviewText(grezzo);
      expect(cleanPreviewText(una), `«${grezzo}» → «${una}» → «${cleanPreviewText(una)}»`).toBe(una);
    });
  }
});
