/**
 * The comparison of topic:64095902, as `show_view` arguments (GENUI-01).
 *
 * Real data, copied from that chat on 08/10: the three stays the agent had
 * narrowed down (prices, ratings, walking minutes, house rules) and the page
 * it had hand-written for them in `~/.topics/media/sitges-alloggi/`. Here the
 * same content is DATA, which is the whole point of the change. The verdict
 * is the one the agent gave between these three ("of the two, Nautilus";
 * El Cid is a non-smoking hotel).
 *
 * `img` is the folder the photos are served from: the spec stages copies of
 * the agent's downloads under the test server's uploads, or generated
 * stand-ins where those files do not exist (CI).
 */

export const SITGES_PHOTOS = {
  bh: ["bh_01.jpg", "bh_04.jpg", "bh_06.jpg", "bh_03.jpg", "bh_02.jpg", "bh_11.jpg"],
  naut: ["naut_00.jpg", "naut_02.jpg", "naut_03.jpg", "naut_01.jpg", "naut_07.jpg"],
  cid: ["cid_00.jpg", "cid_01.jpg", "cid_02.jpg", "cid_04.jpg", "cid_06.jpg"],
} as const;

const walk = (centre: number, beach: number, station: number, bus: number) => [
  { label: "centro", value: centre, unit: "min", better: "lower" },
  { label: "spiaggia", value: beach, unit: "min", better: "lower" },
  { label: "stazione", value: station, unit: "min", better: "lower" },
  { label: "bus aeroporto", value: bus, unit: "min", better: "lower" },
];

const photos = (img: string, files: readonly string[], captions: string[]) =>
  files.map((f, i) => ({ src: `${img}/${f}`, caption: captions[i] }));

export function sitgesCompare(img: string) {
  return {
    view: "compare",
    title: "Sitges, lun 19 - mer 21 ottobre",
    subtitle: "2 notti, 2 persone. Prezzi totali con tasse; minuti a piedi, posizione Airbnb indicativa.",
    verdict: "Nautilus: suite tutta vostra a 3 minuti dal centro e 6 dalla stazione, e il regolamento permette di fumare sul balcone. Chiedete all'host la suite col balcone.",
    options: [
      {
        title: "Beach Haven",
        subtitle: "Camera in casa dell'host, lungomare ovest · Airbnb · 4,86 su 21",
        price: { amount: 184, currency: "EUR", note: "totale, 2 notti" },
        images: photos(img, SITGES_PHOTOS.bh, ["Terrazza vista mare", "Colazione in terrazza", "Camera", "Soggiorno della casa", "Piscina condominiale", "Vista dalla finestra"]),
        pros: ["Colazione inclusa", "Terrazza vista mare: l'annuncio dice che lì si fuma", "Mare a 30 m, zona tranquilla, piscina"],
        cons: ["In casa dell'host: terrazza in comune, camera senza serratura", "Il più lontano da centro e stazione"],
        metrics: walk(12, 3, 17, 9),
        link: { url: "https://www.airbnb.it/rooms/1634138580129746415?check_in=2026-10-19&check_out=2026-10-21&adults=2", label: "Apri su Airbnb" },
      },
      {
        title: "Nautilus",
        subtitle: "Suite in boutique hotel, centro storico · Airbnb · 4,62 su 101",
        price: { amount: 184, currency: "EUR", note: "totale, 2 notti" },
        images: photos(img, SITGES_PHOTOS.naut, ["Camera con porta-finestra", "Letto", "Angolo TV e tavolino", "Bagno", "La via"]),
        pros: ["Il più centrale: tutto entro 7 minuti", "Regolamento: si fuma sui balconi, se la suite ce l'ha", "Suite tutta vostra, voto posizione 4,8"],
        cons: ["Niente colazione: al bar, circa 10 € a testa", "Il balcone va chiesto all'host: non tutte le suite ce l'hanno"],
        metrics: walk(3, 4, 6, 7),
        link: { url: "https://www.airbnb.it/rooms/22809883?check_in=2026-10-19&check_out=2026-10-21&adults=2", label: "Apri su Airbnb" },
        recommended: true,
      },
      {
        title: "Hotel El Cid",
        subtitle: "Camera con balcone, 16 m² · Booking · posizione 9,5 su 3.246 giudizi",
        price: { amount: 180, currency: "EUR", note: "colazione inclusa, 2 notti" },
        images: photos(img, SITGES_PHOTOS.cid, ["Camera (foto tipo)", "Terrazza sui tetti", "Colazione a buffet", "Piscina", "Bagno"]),
        pros: ["Colazione a buffet inclusa, ed è il più economico", "Bus aeroporto a 4 minuti, stazione a 6", "Cancellazione gratis fino al 17 ottobre, paghi in hotel"],
        cons: ["Hotel per non fumatori: sul balcone non lo dice", "Arredo vecchio stile"],
        metrics: walk(6, 6, 6, 4),
        link: { url: "https://www.booking.com/hotel/es/el-cid.it.html?checkin=2026-10-19&checkout=2026-10-21&group_adults=2", label: "Apri su Booking" },
      },
    ],
  };
}
