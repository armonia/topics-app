/**
 * Every example case of the preview, one file each. Order: the six complete
 * Nocera cases first, then the lighter ones, then SARIM's.
 */
import type { CaseSeed } from '../types';
import { CASE_2417 } from './2417';
import { CASE_2418 } from './2418';
import { CASE_2416 } from './2416';
import { CASE_2386 } from './2386';
import { CASE_2419 } from './2419';
import { CASE_2420 } from './2420';
import { CASE_2409 } from './2409';
import { CASE_2395 } from './2395';
import { CASE_2381 } from './2381';
import { CASE_2421 } from './2421';
import { CASE_2404 } from './2404';
import { CASE_S0153 } from './S-0153';
import { CASE_S0149 } from './S-0149';
import { CASE_S0151 } from './S-0151';

export const CASES: CaseSeed[] = [
  // Complete: ricorso, sgravio, concessione, accesso civico, segnalazione, fattura.
  CASE_2418,
  CASE_2417,
  CASE_2416,
  CASE_2386,
  CASE_2419,
  CASE_2420,
  CASE_2409,
  // Lighter: polizia idraulica, turno irriguo, Regione, notifica SEND.
  CASE_2395,
  CASE_2381,
  CASE_2421,
  CASE_2404,
  // SARIM: segnalazione AMA, fattura passiva, FIR.
  CASE_S0153,
  CASE_S0149,
  CASE_S0151,
];
