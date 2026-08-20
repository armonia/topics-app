/**
 * MorphText — una frase che viene RISCRITTA, invece di essere sostituita.
 *
 * Il piano (cosa e' cambiato, quanto dura) lo calcola `lib/textMorph`; qui c'e'
 * solo il modo di disegnarlo, e le tre scelte che lo rendono usabile su una
 * board con cinquanta card.
 *
 * 1. A RIPOSO NON ESISTE. Finche' il testo non cambia questo componente rende
 *    una stringa e basta: zero nodi in piu', zero classi, niente da confrontare
 *    per React. Le lettere in `span` compaiono solo per i ~300ms
 *    dell'animazione e poi il DOM torna a essere quello di prima. Una card ha
 *    gia' venti nodi; venticinque titoli spezzati in lettere e tenuti cosi'
 *    sarebbero migliaia di nodi vivi per un effetto che dura un attimo.
 *
 * 2. LE PAROLE NON SI SPEZZANO. Ogni lettera e' un `inline-block`, e fra due
 *    `inline-block` il browser puo' andare a capo: senza precauzioni una card
 *    stretta avrebbe mandato a capo mezza parola per la durata dell'animazione,
 *    spostando tutto il resto del corpo. Le lettere di una parola stanno dentro
 *    un `.morph-word` (`white-space: nowrap`), quindi i punti dove la frase va a
 *    capo restano gli spazi, come sempre.
 *
 * 3. CHI HA CHIESTO MENO MOVIMENTO NON NE VEDE. Il piano non viene nemmeno
 *    calcolato: il testo nuovo appare, che e' esattamente il comportamento di
 *    prima.
 *
 * La chiave `seq` sull'involucro non e' decorazione: una seconda riscrittura
 * mentre la prima e' ancora in volo deve RIPARTIRE, e un'animazione CSS riparte
 * solo se il nodo e' nuovo. Senza chiave nuova React riuserebbe gli stessi span
 * e la seconda modifica sarebbe muta.
 */
import { useEffect, useRef, useState } from 'react';

import { morphPlan, morphWordChunks, type MorphPlan } from '../../lib/textMorph';
import { prefersReducedMotion } from '../../lib/reducedMotion';

interface Volo {
  plan: MorphPlan;
  seq: number;
}

export function MorphText({ text }: { text: string }) {
  const precedente = useRef(text);
  const seq = useRef(0);
  const [volo, setVolo] = useState<Volo | null>(null);

  useEffect(() => {
    if (precedente.current === text) return;
    const plan = prefersReducedMotion() ? null : morphPlan(precedente.current, text);
    precedente.current = text;
    if (!plan) return;
    seq.current += 1;
    setVolo({ plan, seq: seq.current });
    // +60ms: il timer non deve arrivare PRIMA dell'ultima lettera. L'ultima
    // parte a `(n-1) * step` e dura `MOTION.base`, che e' gia' dentro
    // `durationMs`; il margine copre il fotogramma in cui l'animazione si posa.
    const t = setTimeout(() => setVolo(null), plan.durationMs + 60);
    return () => clearTimeout(t);
  }, [text]);

  if (!volo) return <>{text}</>;

  if (volo.plan.kind === 'block') {
    return <span key={volo.seq} className="morph-block">{text}</span>;
  }

  const { prefix, changed, suffix, stepMs } = volo.plan;
  let indice = -1;
  return (
    <span key={volo.seq}>
      {prefix}
      {morphWordChunks(changed).map((chunk, ci) => {
        if (/^\s+$/u.test(chunk)) {
          // Uno spazio consuma il suo posto nella scaletta (il ritmo resta
          // quello della frase) ma non e' una lettera da far entrare.
          // eslint-disable-next-line react-hooks/immutability -- contatore di RITMO: `map` gira in modo sincrono dentro questo stesso render e nessuna closure gli sopravvive, quindi la riassegnazione non puo' essere letta "dopo il render". Serve una scaletta CONTINUA fra chunk diversi, che un indice per-chunk non puo' dare.
          indice += Array.from(chunk).length;
          return <span key={`s${ci}`}>{chunk}</span>;
        }
        return (
          <span key={`w${ci}`} className="morph-word">
            {Array.from(chunk).map((ch, k) => {
              indice += 1;
              return (
                <span key={k} className="morph-char" style={{ animationDelay: `${Math.round(indice * stepMs)}ms` }}>
                  {ch}
                </span>
              );
            })}
          </span>
        );
      })}
      {suffix}
    </span>
  );
}
