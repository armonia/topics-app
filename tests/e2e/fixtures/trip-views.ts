/**
 * The trip of topic:64095902 as `table` and `timeline` views (GENUI-06/07).
 *
 * Real data, as the chat and its agents read it on 2026-10-08: the AVE
 * Huesca → Sants 08:05 → 11:24, the Avanza bus at 16:30 (3 h 50, from
 * 12,70 €), bus 1149 from T1 (16:50, 9,25 € on board, 32 min) or a taxi at
 * 47-53 €, and Wednesday's return to T2 for easyJet U24212 at 14:10. A value
 * nobody read is left empty (`null`) and said so in the footnote: a view that
 * fills gaps with guesses is the slop this feature exists to remove.
 */
export function trainsTable(): Record<string, unknown> {
  return {
    view: 'table',
    title: 'Huesca → Barcelona Sants, lunedì 19 ottobre',
    subtitle: 'Per lei, prima di prendere la R2 Sud per Sitges',
    verdict: "L'AVE delle 08:05: è l'unico treno con un orario letto, a Sants alle 11:24 e a Sitges prima di pranzo.",
    columns: [
      { label: 'Mezzo' },
      { label: 'Partenza' },
      { label: 'Arrivo' },
      { label: 'Durata', format: 'duration', better: 'lower' },
      { label: 'Prezzo', format: 'price', unit: 'EUR', better: 'lower' },
    ],
    rows: [
      { cells: ['AVE Renfe', '08:05', '11:24', 199, null], recommended: true, link: { url: 'https://venta.renfe.com/', label: 'Biglietti Renfe' } },
      { cells: ['Treno via Zaragoza', null, null, 180, 22.3], note: 'Orari del 19 non letti' },
      { cells: ['Bus Avanza', '16:30', '20:20', 230, 12.7], note: "L'ultimo dei 4 del giorno" },
    ],
    footnote: "Prezzo dell'AVE da leggere su venta.renfe.com. Da Sants a Sitges: R2 Sud, circa 40 minuti.",
  };
}

export function doorToDoorTimeline(): Record<string, unknown> {
  return {
    view: 'timeline',
    title: 'Porta a porta per Attilio, 19-21 ottobre',
    subtitle: 'Aeroporto di Barcellona ↔ Sitges',
    verdict: 'Bus 1149 andata e ritorno: 18,50 € in tutto. Il taxi conviene solo con molte valigie.',
    steps: [
      { day: 'Lunedì 19', time: '16:00', mode: 'plane', title: 'Atterraggio a BCN, Terminal 1', detail: 'Vueling VY6505' },
      {
        day: 'Lunedì 19', time: '16:50', mode: 'bus', title: 'Bus 1149 dal T1 a Sitges, fermata Can Robert',
        duration: '32 min', price: { amount: 9.25, currency: 'EUR', note: 'a bordo' },
        detail: "Poi 5-15 minuti a piedi, secondo l'alloggio. Corse anche alle 17:20 e 17:50.",
        alternatives: [{ title: 'Taxi dal T1 alla porta', mode: 'taxi', detail: '47-53 €' }],
      },
      {
        day: 'Mercoledì 21', time: '11:30', mode: 'bus', title: 'Bus 1149 da Can Robert al T1',
        detail: 'Arriva al T1 alle 12:00. Quello delle 12:00 è l\'ultimo con margine.',
        price: { amount: 9.25, currency: 'EUR' },
      },
      { day: 'Mercoledì 21', time: '12:00', mode: 'bus', title: 'Navetta gratuita dal T1 al T2', duration: '15 min' },
      { day: 'Mercoledì 21', time: '12:40', title: 'Al Terminal 2', deadline: true, detail: 'Ultimo orario comodo per il volo' },
      { day: 'Mercoledì 21', time: '14:10', mode: 'plane', title: 'Volo easyJet U24212 dal T2' },
    ],
  };
}
