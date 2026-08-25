/**
 * transcript-fork.test.ts — "quale file continua questa sessione?"
 *
 * Le forme dei dati qui sotto vengono da fork VERI in ~/.claude/projects: il
 * figlio ricopia le righe del padre con i loro uuid, ma intercala righe nuove
 * (`attachment`, `file-history-*`) e righe di servizio senza uuid
 * (`mode`, `ai-title`, `queue-operation`). Il riconoscimento deve reggerle.
 *
 * @covers EXTSESS-07
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findForkContinuation, collectConsumedUuids, scanCopiedPrefix } from './transcript-fork';

const jline = (o: object) => JSON.stringify(o);
const user = (uuid: string, text: string) => jline({ type: 'user', uuid, message: { role: 'user', content: text } });
const asst = (uuid: string, text: string) => jline({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
/** Riga di servizio senza uuid — la CLI ne scrive parecchie. */
const meta = (type: string) => jline({ type, timestamp: '2026-07-30T10:00:00Z' });

let dir: string;

/** Scrive un transcript e gli mette un mtime relativo a "adesso" (secondi fa). */
function write(name: string, lines: string[], agoSec: number): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n') + '\n');
  const t = Date.now() / 1000 - agoSec;
  utimesSync(p, t, t);
  return p;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fork-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('findForkContinuation', () => {
  it('trova il figlio che ricopia le righe già consumate e riprende dopo la copia', async () => {
    const parent = write('11111111-aaaa.jsonl', [user('u1', 'ciao'), asst('a1', 'ciao a te')], 60);
    const consumed = statSync(parent).size;
    const copied = [user('u1', 'ciao'), asst('a1', 'ciao a te')];
    const child = write('22222222-bbbb.jsonl', [...copied, user('u2', 'nuova'), asst('a2', 'nuova risposta')], 5);

    const { found } = await findForkContinuation({ currentPath: parent, consumedBytes: consumed });
    expect(found).not.toBeNull();
    expect(found!.path).toBe(child);
    expect(found!.sessionId).toBe('22222222-bbbb');
    expect(found!.matched).toBe(2);
    // il cursore cade DOPO la copia: la coda inedita resta da importare
    expect(found!.offset).toBe(Buffer.byteLength(copied.join('\n') + '\n', 'utf-8'));
  });

  it('regge le righe nuove intercalate dentro la copia (attachment, file-history, mode)', async () => {
    const parent = write('11111111-aaaa.jsonl', [user('u1', 'a'), asst('a1', 'b'), user('u2', 'c')], 60);
    const consumed = statSync(parent).size;
    // Come i fork veri: la copia è punteggiata di righe che il padre non ha.
    const copiedBlock = [
      meta('mode'),
      user('u1', 'a'),
      jline({ type: 'attachment', uuid: 'x-nuovo-1', content: 'rigenerato' }),
      asst('a1', 'b'),
      meta('ai-title'),
      user('u2', 'c'),
    ];
    write('22222222-bbbb.jsonl', [...copiedBlock, asst('a9', 'coda inedita')], 5);

    const { found } = await findForkContinuation({ currentPath: parent, consumedBytes: consumed });
    expect(found!.matched).toBe(3);
    expect(found!.offset).toBe(Buffer.byteLength(copiedBlock.join('\n') + '\n', 'utf-8'));
  });

  it('ignora un transcript estraneo, anche se è il più recente della cartella', async () => {
    const parent = write('11111111-aaaa.jsonl', [user('u1', 'ciao')], 60);
    write('33333333-cccc.jsonl', [user('z1', 'sessione di un altro topic')], 1);

    const { found, rejected } = await findForkContinuation({ currentPath: parent, consumedBytes: statSync(parent).size });
    expect(found).toBeNull();
    expect(rejected.map((r) => r.path.endsWith('33333333-cccc.jsonl'))).toEqual([true]);
  });

  it('ignora un file PIÙ VECCHIO del nostro anche se condivide gli uuid', async () => {
    // Il vecchio è il PADRE da cui noi stessi siamo nati: non ci continua.
    write('00000000-nonno.jsonl', [user('u1', 'ciao')], 600);
    const parent = write('11111111-aaaa.jsonl', [user('u1', 'ciao'), asst('a1', 'ok')], 60);
    const { found } = await findForkContinuation({ currentPath: parent, consumedBytes: statSync(parent).size });
    expect(found).toBeNull();
  });

  it('non aggancia un transcript già seguito da un altro topic', async () => {
    const parent = write('11111111-aaaa.jsonl', [user('u1', 'ciao')], 60);
    const other = write('22222222-bbbb.jsonl', [user('u1', 'ciao'), asst('a2', 'coda')], 5);
    const { found } = await findForkContinuation({
      currentPath: parent, consumedBytes: statSync(parent).size,
      isPathTaken: (p) => p === other,
    });
    expect(found).toBeNull();
  });

  it('non riesamina un candidato già scartato e immutato (cache dei rifiuti)', async () => {
    const parent = write('11111111-aaaa.jsonl', [user('u1', 'ciao')], 60);
    const stranger = write('33333333-cccc.jsonl', [user('z1', 'altro')], 1);
    const mtime = statSync(stranger).mtimeMs;
    const skipped: string[] = [];
    const { found, rejected } = await findForkContinuation({
      currentPath: parent, consumedBytes: statSync(parent).size,
      skip: (p, m) => { if (m === mtime) { skipped.push(p); return true; } return false; },
    });
    expect(found).toBeNull();
    expect(skipped).toEqual([stranger]);
    expect(rejected).toEqual([]); // nemmeno aperto
  });

  it('senza byte consumati non c\'è storia nota: nessun aggancio', async () => {
    const parent = write('11111111-aaaa.jsonl', [user('u1', 'ciao')], 60);
    write('22222222-bbbb.jsonl', [user('u1', 'ciao'), asst('a2', 'coda')], 5);
    const { found } = await findForkContinuation({ currentPath: parent, consumedBytes: 0 });
    expect(found).toBeNull();
  });

  it('con il transcript corrente sparito non si indovina: nessun aggancio', async () => {
    const parent = join(dir, 'inesistente.jsonl');
    write('22222222-bbbb.jsonl', [user('u1', 'ciao'), asst('a2', 'coda')], 5);
    const { found } = await findForkContinuation({ currentPath: parent, consumedBytes: 100 });
    expect(found).toBeNull();
  });

  it('sceglie, tra due candidati, quello che ricopia di più', async () => {
    const parent = write('11111111-aaaa.jsonl', [user('u1', 'a'), asst('a1', 'b'), user('u2', 'c')], 60);
    const consumed = statSync(parent).size;
    write('22222222-poco.jsonl', [user('u1', 'a'), asst('z9', 'coda')], 3);
    const molto = write('44444444-molto.jsonl', [user('u1', 'a'), asst('a1', 'b'), user('u2', 'c'), asst('z8', 'coda')], 9);
    const { found, rejected } = await findForkContinuation({ currentPath: parent, consumedBytes: consumed });
    expect(found!.path).toBe(molto);
    expect(found!.matched).toBe(3);
    expect(rejected).toHaveLength(1);
  });

  it('conta solo gli uuid DENTRO i byte consumati', async () => {
    const consumedLines = [user('u1', 'a'), asst('a1', 'b')];
    const head = consumedLines.join('\n') + '\n';
    const parent = write('11111111-aaaa.jsonl', [...consumedLines, user('u3', 'non ancora importata')], 60);
    const known = await collectConsumedUuids(parent, Buffer.byteLength(head, 'utf-8'));
    expect([...known].sort()).toEqual(['a1', 'u1']);
  });

  it('la riga parziale in coda non entra nel cursore', async () => {
    const complete = user('u1', 'a') + '\n';
    const p = join(dir, 'x.jsonl');
    writeFileSync(p, complete + '{"type":"user","uu'); // scrittura a metà
    const res = await scanCopiedPrefix(p, new Set(['u1']), 200);
    expect(res).toEqual({ offset: Buffer.byteLength(complete, 'utf-8'), matched: 1 });
  });

  it('smette di leggere dopo una lunga corsa di righe ignote (divergenza)', async () => {
    const parent = write('11111111-aaaa.jsonl', [user('u1', 'a')], 60);
    const tail = Array.from({ length: 30 }, (_, i) => asst(`n${i}`, `coda ${i}`));
    write('22222222-bbbb.jsonl', [user('u1', 'a'), ...tail], 5);
    const { found } = await findForkContinuation({
      currentPath: parent, consumedBytes: statSync(parent).size, divergenceRun: 3,
    });
    // il cursore resta all'ultima riga nota: tutta la coda va importata
    expect(found!.offset).toBe(Buffer.byteLength(user('u1', 'a') + '\n', 'utf-8'));
    expect(found!.matched).toBe(1);
  });

  it('scarta i candidati troppo grandi da scansionare', async () => {
    const parent = write('11111111-aaaa.jsonl', [user('u1', 'a')], 60);
    write('22222222-bbbb.jsonl', [user('u1', 'a'), asst('a2', 'coda')], 5);
    const { found } = await findForkContinuation({
      currentPath: parent, consumedBytes: statSync(parent).size, maxScanBytes: 10,
    });
    expect(found).toBeNull();
  });
});
