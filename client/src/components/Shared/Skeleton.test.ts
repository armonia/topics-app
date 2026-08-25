/**
 * L'ATTESA DEVE AVERE LA FORMA DI CIÒ CHE ARRIVA — e due modi di tradirla.
 *
 * 1. LO SCHELETRO DELLA CHAT STAVA NELLE FASCE CHE NON SONO SUE. Il contenitore
 *    del trascritto si prende tutta la cella: risale sotto la barra di chrome
 *    (margine negativo di `.chat-under-chrome:first-child`) e continua sotto il
 *    composer, che gli sta sopra in `absolute bottom-0`. Il contenuto vero non
 *    ci finisce dentro perché Virtuoso apre un Header alto `--chat-gutter` e un
 *    Footer alto `inputAreaHeight + CHAT_BOTTOM_GUTTER_PX`. Lo scheletro è un
 *    fratello `absolute` dello scroller: quei due varchi non li eredita, e con
 *    `inset-0` nasceva mezzo sotto il vetro con le bolle basse dietro al
 *    composer. Il primo frame di contenuto vero le rimetteva a posto: cioè
 *    l'attesa mostrava un salto invece di evitarlo.
 *
 * 2. L'ANELLO TORNAVA A ESSERE COPIATO A MANO. `Spinner.tsx` esiste perché lo
 *    stesso markup girava in 24 posti con tre spessori diversi; ne erano
 *    ricomparsi quattro (la pane lazy, la board, il bottone di invio, l'apply
 *    all), e uno col cerchio spento preso dal token sbagliato. È una modifica
 *    di una riga a rifarlo, quindi la controlla un test invece della memoria.
 *
 * Perché sul SORGENTE e non montando: `Skeleton.tsx` importa `@/lib/…` e
 * `bun test` non risolve quell'alias (stesso motivo, e stesso metodo, di
 * `GlobalCapControl.test.tsx` e `ThreadRuns.test.tsx`).
 *
 * @covers PERF-01
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SHARED = import.meta.dir;
const CLIENT_SRC = join(SHARED, '..', '..');
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');

const skeleton = read(SHARED, 'Skeleton.tsx');
const messageList = read(CLIENT_SRC, 'components', 'Chat', 'MessageList.tsx');

describe('scheletro della chat', () => {
  test('lascia in cima il varco della barra di chrome', () => {
    expect(skeleton).toContain("top: 'var(--chat-gutter, 0px)'");
  });

  test('il rientro è sul box, non un padding (overflow-hidden taglia al padding)', () => {
    // `inset-0` + `pt-…` avrebbe rimesso le bolle sotto il vetro appena la pila
    // supera l'altezza disponibile: il taglio deve cadere sul bordo del box.
    const corpo = skeleton.slice(skeleton.indexOf('export function SkeletonChatMessages'));
    expect(corpo).not.toContain('inset-0');
    expect(corpo).toContain('inset-x-0');
  });

  test('lascia in fondo la fascia del composer, misurata da chi chiama', () => {
    expect(skeleton).toContain('bottom: bottomInset');
    // Entrambi i punti di innesto (chat senza niente da mostrare, e sipario
    // sulla lista che si posa) passano la banda VERA: l'altezza misurata del
    // composer più lo stesso gutter del Footer di Virtuoso.
    const usi = messageList.match(/<SkeletonChatMessages[^/]*\/>/g) ?? [];
    expect(usi.length).toBeGreaterThan(0);
    for (const uso of usi) {
      expect(uso).toContain('bottomInset={inputAreaHeight + CHAT_BOTTOM_GUTTER_PX}');
    }
  });

  test('il Footer vero e lo scheletro sommano lo stesso gutter', () => {
    // Se qualcuno cambia il Footer di Virtuoso e non questo, le due attese si
    // scollano di nuovo: il numero è uno solo e ha un nome.
    expect(messageList).toContain('height: inputAreaHeight + CHAT_BOTTOM_GUTTER_PX');
  });
});

/** Ogni .ts/.tsx sotto client/src, per il controllo globale qui sotto. */
function sorgenti(dir: string, out: string[] = []): string[] {
  for (const voce of readdirSync(dir)) {
    if (voce === 'node_modules') continue;
    const p = join(dir, voce);
    if (statSync(p).isDirectory()) sorgenti(p, out);
    else if (/\.tsx?$/.test(voce) && !/\.test\.tsx?$/.test(voce)) out.push(p);
  }
  return out;
}

describe('anello di caricamento', () => {
  test("nessuno se lo ridisegna a mano fuori da Spinner.tsx", () => {
    const colpevoli = sorgenti(CLIENT_SRC)
      .filter((p) => !p.endsWith(join('Shared', 'Spinner.tsx')))
      .filter((p) => /rounded-full[^"'`]*animate-spin|animate-spin[^"'`]*rounded-full/.test(read(p)))
      .map((p) => p.slice(CLIENT_SRC.length + 1));
    expect(colpevoli).toEqual([]);
  });
});
