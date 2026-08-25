/**
 * The colour and the word each git status gets in the file tree.
 *
 * @covers FILE-02
 */
import { test, expect, describe } from 'bun:test';
import { gitStatusTextClass, gitStatusLabel } from './gitStatusColors';

describe('gitStatusTextClass', () => {
  // IL PUNTO DEL MODULO: ogni tinta è una COPPIA. Una classe nuda vale per un
  // tema solo, ed è esattamente il baco per cui questo file esiste — in tema
  // chiaro l'albero dei file dipingeva col colore tarato sul fondo scuro.
  // Il grigio muto del fallback è l'unica eccezione legittima: è un token
  // dell'app, che il tema se lo cambia da sé.
  test('ogni stato riconosciuto porta una coppia chiaro/scuro', () => {
    for (const code of ['M ', ' M', 'MM', 'A ', 'AM', ' D', 'D ', 'R  ', 'RM', 'C ', '??']) {
      const cls = gitStatusTextClass(code);
      // Il GRADINO chiaro non è uno solo: dipende dal contrasto della singola
      // tinta sul fondo su cui atterra (700 per rosso/blu/viola, 800 per ambra
      // e verde, che a 700 restavano sotto AA sul chrome — vedi il modulo). Ciò
      // che il test difende è la COPPIA: una classe nuda vale per un tema solo,
      // ed è il baco per cui questo file esiste.
      expect(cls, `stato ${JSON.stringify(code)}`).toMatch(/^text-[a-z]+-[78]00 dark:text-[a-z]+-400$/);
    }
  });

  test('lo stato sconosciuto è il grigio muto, non l\'ambra del modificato', () => {
    expect(gitStatusTextClass('XY')).toBe('text-app-text-muted');
  });

  // Il codice arriva a DUE caratteri dal watcher (`"A "`, `" D"`): senza
  // normalizzarlo, aggiunta e cancellazione non incrociavano i casi a un
  // carattere e cadevano nel fallback vestite da «modificato».
  test('lo spazio della colonna non cambia la famiglia', () => {
    expect(gitStatusTextClass('A ')).toBe(gitStatusTextClass(' A'));
    expect(gitStatusTextClass('M ')).toBe(gitStatusTextClass(' M'));
    expect(gitStatusTextClass('D ')).toBe(gitStatusTextClass(' D'));
  });

  test('le famiglie non si confondono fra loro', () => {
    const aggiunto = gitStatusTextClass('A ');
    const modificato = gitStatusTextClass('M ');
    const cancellato = gitStatusTextClass(' D');
    const rinominato = gitStatusTextClass('R ');
    const nonTracciato = gitStatusTextClass('??');
    expect(new Set([aggiunto, modificato, cancellato, rinominato, nonTracciato]).size).toBe(5);
  });

  // Un conflitto è l'unico stato che CHIEDE di fare qualcosa: deve leggersi
  // come il rosso della cancellazione, non cadere nel grigio del fallback.
  test('i conflitti prendono il rosso, non il fallback', () => {
    for (const code of ['UU', 'AA', 'DD', 'AU', 'UD']) {
      expect(gitStatusTextClass(code), `conflitto ${code}`).toBe(gitStatusTextClass(' D'));
    }
  });
});

describe('gitStatusLabel', () => {
  test('le lettere degli stati noti', () => {
    expect(gitStatusLabel('??')).toBe('U');
    expect(gitStatusLabel('A ')).toBe('A');
    expect(gitStatusLabel('AM')).toBe('A');
    expect(gitStatusLabel(' D')).toBe('D');
    expect(gitStatusLabel('MM')).toBe('M');
    expect(gitStatusLabel('R ')).toBe('R');
    expect(gitStatusLabel('C ')).toBe('C');
  });

  // Prima il fallback stampava 'M': un codice che non conosciamo mostrato come
  // «modificato» è un'informazione falsa, e costa più di un codice strano.
  test('un codice sconosciuto si stampa com\'è, non come M', () => {
    expect(gitStatusLabel('XY')).toBe('XY');
  });
});
