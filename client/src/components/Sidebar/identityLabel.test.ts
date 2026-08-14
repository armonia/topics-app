/**
 * Il test che diventa rosso se la riga torna a dire il ferro.
 *
 * Il caso che conta è il PRIMO: persona nota e sessione loopback, cioè
 * esattamente la situazione in cui il server risponde «Questo computer». Se
 * qualcuno rimette il nome del ferro davanti, questo caso fallisce nominando la
 * stringa che era il difetto.
 */
import { describe, it, expect } from 'bun:test';
import { etichettaIdentita, iniziali } from './identityLabel';
import type { SessionState } from '@/lib/auth/session';

const loopback: SessionState = {
  status: 'paired', as: 'loopback', name: 'Questo computer', role: 'owner',
};
const telefono: SessionState = {
  status: 'paired', as: 'device', name: 'iPhone di Attilio', role: 'owner', deviceId: 'd1',
};
const attilio = { displayName: 'Attilio Cianci', github: null };

describe('etichettaIdentita', () => {
  it('sul computer mostra la PERSONA, non «Questo computer»', () => {
    const e = etichettaIdentita(attilio, loopback);
    expect(e.nome).toBe('Attilio Cianci');
    expect(e.nome).not.toBe('Questo computer');
    expect(e.personale).toBe(true);
  });

  it('il ferro non sparisce: scende a dettaglio', () => {
    expect(etichettaIdentita(attilio, loopback).dettaglio).toBe('Questo computer');
    expect(etichettaIdentita(attilio, telefono).dettaglio).toBe('iPhone di Attilio');
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
      { displayName: 'Attilio Cianci', github: { avatarUrl: 'https://x/a.png' } as never },
      loopback,
    );
    expect(e.avatarUrl).toBe('https://x/a.png');
    expect(e.iniziali).toBe('AC');
  });
});

describe('iniziali', () => {
  it('due parole danno due lettere, una parola ne dà una', () => {
    expect(iniziali('Attilio Cianci')).toBe('AC');
    expect(iniziali('Mac')).toBe('M');
  });
  it('si ferma a due anche con tre parole', () => {
    expect(iniziali('Anna Maria Rossi')).toBe('AM');
  });
});
