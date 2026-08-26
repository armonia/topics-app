// Entry point. Il daemon parla lo STESSO protocollo su tutte e tre le piattaforme;
// cambia solo il tubo sotto (`transport`): un socket Unix su macOS e Linux, una
// named pipe su Windows.
//
// Fino al 2026-08-26 questo file compilava a un no-op su Windows, e lo diceva:
// «Windows keeps the pre-existing 503 "no terminals in standalone" path». Cioe'
// su Windows Topics si installava, si apriva, e non poteva aprire un terminale
// - in un'app il cui scopo e' far girare agenti da riga di comando.

mod bridge;
mod transport;

fn main() {
    bridge::run();
}
