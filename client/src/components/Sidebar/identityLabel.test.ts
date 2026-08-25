/**
 * Il test che diventa rosso se la riga torna a dire il ferro.
 *
 * Il caso che conta è il PRIMO: persona nota e sessione loopback, cioè
 * esattamente la situazione in cui il server risponde «Questo computer». Se
 * qualcuno rimette il nome del ferro davanti, questo caso fallisce nominando la
 * stringa che era il difetto.
  *
 * @covers STATUSLINE-01
 */
import { describe, it, expect } from 'bun:test';
import { etichettaIdentita, iniziali } from './identityLabel';
import type { SessionState } from '@/lib/auth/session';

const loopback: SessionState = {
  status: 'paired', as: 'loopback', name: 'Questo computer', role: 'owner',
};
const telefono: SessionState = {
  status: 'paired', as: 'device', name: 'iPhone di Nome', role: 'owner', deviceId: 'd1',
};
const persona = { displayName: 'Nome Cognome', github: null };

describe('etichettaIdentita', () => {
  it('sul computer mostra la PERSONA, non «Questo computer»', () => {
    const e = etichettaIdentita(persona, loopback);
    expect(e.nome).toBe('Nome Cognome');
    expect(e.nome).not.toBe('Questo computer');
    expect(e.personale).toBe(true);
  });

  it('il ferro non sparisce: scende a dettaglio', () => {
    expect(etichettaIdentita(persona, loopback).dettaglio).toBe('Questo computer');
    expect(etichettaIdentita(persona, telefono).dettaglio).toBe('iPhone di Nome');
  });

  it('senza persona resta il ferro, e nessun nome inventato', () => {
    const e = etichettaIdentita(null, loopback);
    expect(e.nome).toBe('Questo computer');
    expect(e.personale).toBe(false);
    // Niente seconda riga: ripetere il ferro sotto il ferro non è un dettaglio.
    expect(e.dettaglio).toBe('');
  });

  it('un nome fatto di soli spazi non è un nome', () => {
    expect(etichettaIdentita({ displayName: '   ', github: null }, loopback).personale).toBe(false);
  });

  it('la sessione non ancora risolta non produce testo da nessuna parte', () => {
    const e = etichettaIdentita(null, { status: 'loading' });
    expect(e.nome).toBe('');
    expect(e.iniziali).toBe('');
  });

  it('la faccia di GitHub vince sulle iniziali quando c’è', () => {
    const e = etichettaIdentita(
      { displayName: 'Nome Cognome', github: { avatarUrl: 'https://x/a.png' } as never },
      loopback,
    );
    expect(e.avatarUrl).toBe('https://x/a.png');
    expect(e.iniziali).toBe('NC');
  });
});

describe('iniziali', () => {
  it('due parole danno due lettere, una parola ne dà una', () => {
    expect(iniziali('Nome Cognome')).toBe('NC');
    expect(iniziali('Mac')).toBe('M');
  });
  it('si ferma a due anche con tre parole', () => {
    expect(iniziali('Anna Maria Rossi')).toBe('AM');
  });
});
