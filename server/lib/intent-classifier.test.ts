/**
 * The keyword fallback (no network) and the Groq path with a mocked fetch.
 */
import { describe, test, expect } from 'bun:test';
import { classifyByKeyword, classifyIntent } from './intent-classifier';

describe('classifyByKeyword', () => {
  test('un assenso netto è approve', () => {
    expect(classifyByKeyword('ok va bene').intent).toBe('approve');
    expect(classifyByKeyword('yes sounds good').intent).toBe('approve');
  });

  test('un congedo è close, anche se contiene un assenso', () => {
    expect(classifyByKeyword('basta, va bene così').intent).toBe('close');
  });

  test('qualunque altra cosa è feedback, col testo intero', () => {
    const r = classifyByKeyword('manca ancora il bottone rosso');
    expect(r.intent).toBe('feedback');
    expect(r.text).toBe('manca ancora il bottone rosso');
  });

  test('source è sempre keyword su questo percorso', () => {
    expect(classifyByKeyword('ok').source).toBe('keyword');
  });
});

describe('classifyIntent', () => {
  test('senza GROQ_API_KEY, ripiega sulle parole chiave', async () => {
    const r = await classifyIntent('approvo', { env: {} });
    expect(r).toEqual({ intent: 'approve', source: 'keyword' });
  });

  test('con la chiave, usa la risposta di Groq quando è valida', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"intent":"close"}' } }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await classifyIntent('basta grazie', { env: { GROQ_API_KEY: 'x' }, fetchImpl });
    expect(r).toEqual({ intent: 'close', source: 'groq' });
  });

  test('Groq giù: ripiega comunque sulle parole chiave', async () => {
    const fetchImpl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const r = await classifyIntent('approvo', { env: { GROQ_API_KEY: 'x' }, fetchImpl });
    expect(r).toEqual({ intent: 'approve', source: 'keyword' });
  });

  test('Groq risponde con un intento illeggibile: ripiega sulle parole chiave', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'boh' } }] }), { status: 200 })) as unknown as typeof fetch;
    const r = await classifyIntent('approvo', { env: { GROQ_API_KEY: 'x' }, fetchImpl });
    expect(r).toEqual({ intent: 'approve', source: 'keyword' });
  });
});
