#!/usr/bin/env python3
"""
probe.py - lo strumento di misura del banco «⌘R nei tre contesti».

Si lancia a mano, non lo importa nessuno. Serve a guardare la finestra di
Topics SENZA aprire un'immagine: risponde in numeri e in testo.

    probe.py rect                     -> il rettangolo globale della finestra
    probe.py shot   out.png           -> cattura la finestra (coordinate globali)
    probe.py ocr    img.png [regex]   -> parole + centro in coordinate GLOBALI
    probe.py lum    img.png x y w h   -> luminanza di una regione (in finestra)

Perche' esiste, e perche' non e' un occhio umano. La domanda aperta sulla card
era «il terminale mostra il prompt o e' un rettangolo scuro?». Un rettangolo
scuro non si giudica a occhio: si misura. `lum` stampa media, massimo e quanti
pixel stanno sopra una soglia, cioe' esattamente cio' che distingue «pannello
vuoto» da «pannello con testo sopra».

Le coordinate. La finestra vive su un display secondario con origine negativa,
quindi TUTTE le coordinate che escono di qui sono GLOBALI (quelle che vogliono
`cliclick` e `screencapture -R`), mentre quelle che entrano in `lum` sono
relative alla finestra, che e' come si ragiona guardando uno screenshot.
"""
import os
import re
import subprocess
import sys
import time

import numpy as np
from PIL import Image


def real(path: str) -> str:
    """tesseract (leptonica) non segue il symlink /tmp -> /private/tmp: gli
    passa `image file not found` su un file che esiste. Si risolve prima."""
    return os.path.realpath(path)

# Il binario si chiama `app` (Topics.app/Contents/MacOS/app): e' il nome che
# System Events conosce, non "Topics".
PROC = "app"
# `activate` vuole il bundle id: "Topics" non e' il nome del processo.
BUNDLE = "io.armonia.topics.tauri"


def rect() -> tuple[int, int, int, int]:
    """Rettangolo globale (x, y, w, h) della prima finestra di Topics."""
    out = subprocess.run(
        ["osascript", "-e",
         f'tell application "System Events" to tell process "{PROC}" '
         'to get {position, size} of window 1'],
        capture_output=True, text=True, check=True).stdout
    x, y, w, h = (int(n) for n in re.findall(r"-?\d+", out)[:4])
    return x, y, w, h


def activate() -> None:
    """Porta Topics davanti, e ASPETTA che ci sia arrivato davvero.

    Senza questo la cattura riprende i pixel di chi sta sopra: la prima misura
    di questo banco ha fotografato Discord al posto di Topics, e la card
    racconta la stessa storia con Dia, che torna frontmost da sola ogni pochi
    secondi. `activate` non e' istantaneo, quindi si rilegge chi e' davanti
    invece di fidarsi di una pausa fissa.
    """
    subprocess.run(["osascript", "-e",
                    f'tell application id "{BUNDLE}" to activate'],
                   capture_output=True)
    for _ in range(40):
        who = subprocess.run(
            ["osascript", "-e",
             'tell application "System Events" to get name of first process '
             'whose frontmost is true'],
            capture_output=True, text=True).stdout.strip()
        if who == PROC:
            return
        time.sleep(0.05)
    print("attenzione: davanti c'e' %r, non Topics" % who, file=sys.stderr)


def shot(path: str, front: bool = True) -> tuple[int, int, int, int]:
    if front:
        activate()
    r = rect()
    subprocess.run(
        ["/usr/sbin/screencapture", "-x", "-o",
         "-R%d,%d,%d,%d" % r, path], check=True)
    return r


def ocr(path: str, pattern: str | None) -> None:
    """Parole riconosciute, col centro gia' tradotto in coordinate globali."""
    ox, oy, _, _ = rect()
    tsv = subprocess.run(
        ["tesseract", real(path), "-", "--psm", "6", "tsv"],
        capture_output=True, text=True, errors="replace").stdout
    rx = re.compile(pattern, re.I) if pattern else None
    for line in tsv.splitlines()[1:]:
        f = line.split("\t")
        if len(f) < 12 or not f[11].strip():
            continue
        if float(f[10]) < 40:  # confidenza: sotto 40 e' rumore
            continue
        if rx and not rx.search(f[11]):
            continue
        left, top, w, h = (int(f[i]) for i in (6, 7, 8, 9))
        print("%5d %5d  conf=%3.0f  %s"
              % (ox + left + w // 2, oy + top + h // 2, float(f[10]), f[11]))


def lum(path: str, x: int, y: int, w: int, h: int) -> None:
    """Luminanza di una regione: e' la misura che decide «vuoto» o «scritto»."""
    a = np.asarray(Image.open(path).convert("L").crop((x, y, x + w, y + h)),
                   dtype=float)
    print("regione %dx%d @ %d,%d" % (w, h, x, y))
    print("  media %.1f  min %.0f  max %.0f  dev %.1f"
          % (a.mean(), a.min(), a.max(), a.std()))
    for t in (80, 120, 160, 200):
        print("  pixel sopra %3d: %8d  (%.3f%%)"
              % (t, int((a > t).sum()), (a > t).mean() * 100))


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd = sys.argv[1]
    if cmd == "rect":
        print("%d %d %d %d" % rect())
    elif cmd == "shot":
        print("%d %d %d %d" % shot(sys.argv[2]))
    elif cmd == "front":
        activate()
    elif cmd == "ocr":
        ocr(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == "lum":
        lum(sys.argv[2], *(int(n) for n in sys.argv[3:7]))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
