/**
 * Il testo della modalità notturna, separato dalla card che lo mostra.
 *
 * Stanno qui e non dentro `NightModeCard.tsx` per due ragioni, e la seconda è
 * quella che conta. La prima è meccanica: un file che esporta un componente E
 * altre cose spegne il fast refresh, quindi ogni salvataggio rimontava la card
 * invece di aggiornarla. La seconda è che questa è la parte che si può
 * sbagliare — sbagliarla significa dire a qualcuno che la board sta lavorando
 * mentre è ferma — ed è quindi la parte che vuole essere pura, testabile da
 * sola e senza React intorno.
 */
import { t as translate, type Locale } from '../../lib/i18n';
import type { NightStatus as ApiNightStatus } from '../../lib/board';

/** Il tipo vive in `lib/board.ts` accanto alla chiamata; qui si ri-esporta per i test. */
export type NightStatus = ApiNightStatus;

/** «fra 2h 15min» — la scadenza come DURATA, che è come la si pensa alle 23. */
export function formatCountdown(ms: number, locale: Locale = 'it'): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return translate('time.lessThanAMinute', locale);
  if (min < 60) return translate('time.minutes', locale, { n: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0
    ? translate('time.hours', locale, { n: h })
    : translate('time.hoursMinutes', locale, { h, m });
}

/**
 * Lo stato in parole.
 */
export function describeNight(st: NightStatus | null, enabled: boolean, asked = true): {
  tone: 'off' | 'go' | 'wait';
  /** Chiave i18n del titolo. */
  titleKey: string;
  /** Chiave i18n del dettaglio, oppure `null` quando il dettaglio è testo del server. */
  detailKey: string | null;
  /** Il motivo così come lo dice il server — già in italiano, non traducibile qui. */
  detailText: string | null;
} {
  if (!enabled) {
    return { tone: 'off', titleKey: 'board.night.state.off', detailKey: 'board.night.state.off.detail', detailText: null };
  }
  if (!st) {
    // «Non ho ancora chiesto» NON è «il server non risponde». Confonderli fa
    // lampeggiare un errore per un secondo a ogni accensione, e un errore che
    // sparisce da solo insegna a non fidarsi di quelli veri.
    if (!asked) {
      return { tone: 'wait', titleKey: 'board.night.state.checking', detailKey: null, detailText: null };
    }
    return { tone: 'wait', titleKey: 'board.night.state.unknown', detailKey: 'board.night.state.unknown.detail', detailText: null };
  }
  if (st.action === 'wait') {
    // Il motivo lo calcola il server (`night-mode.ts`) e arriva già scritto: non
    // si ritraduce qui, si mostra. Tradurlo significherebbe tenere due copie
    // della stessa frase e farle divergere.
    return { tone: 'wait', titleKey: 'board.night.state.wait', detailKey: null, detailText: st.reason };
  }
  if (st.action === 'expire') {
    return {
      tone: 'off',
      titleKey: 'board.night.state.expired',
      detailKey: st.reason ? null : 'board.night.state.expired.detail',
      detailText: st.reason ?? null,
    };
  }
  return { tone: 'go', titleKey: 'board.night.state.go', detailKey: 'board.night.state.go.detail', detailText: null };
}
