#!/usr/bin/env python3
"""
clip.py - guida la app viva e misura il toast «Ricaricata» dopo un ⌘R.

Si lancia a mano, non lo importa nessuno. `probe.py` GUARDA la finestra; questo
la TOCCA: porta Topics davanti, mette il fuoco dove gli dici, preme ⌘R, e poi
dice in numeri se il toast e' comparso e per quanti fotogrammi.

    clip.py tabs                        -> le tab in alto, con le coordinate
    clip.py fire <nome> [opzioni]       -> un contesto: fuoco, tasto, misura

    --tab TESTO      prima clicca la tab il cui testo contiene TESTO
    --into X,Y       poi clicca QUI (coordinate globali) per dare il fuoco
    --type TESTO     e batte TESTO: e' la prova che il fuoco e' li'
    --secs N         quanti secondi registrare dopo il tasto (default 4)

I fotogrammi finiscono in out/<nome>/ come PNG della sola finestra, gia'
pronti per essere montati.

Due trappole ci sono costate un turno intero, e stanno qui dentro perche' non
si ripaghino:

1. `cliclick` legge un `-` iniziale come spostamento RELATIVO. La finestra vive
   su un secondo display a coordinate NEGATIVE, quindi ogni click finiva a caso
   e la app sembrava non rispondere. Il prefisso `=` forza l'assoluto.

2. Portare Topics davanti non riesce al primo colpo: Dia, Discord e perfino il
   Terminale da cui parte questo script se lo riprendono. Non basta chiedere
   l'attivazione una volta e poi fidarsi: si richiede, si rilegge chi e'
   davanti, e se non ci si arriva si ESCE. Un click su una finestra sbagliata
   non e' una misura fallita, e' una misura falsa.

(La terza, che vive in probe.py: tesseract non segue il symlink /tmp. Qui si
scrive sotto la cartella dello script, quindi non si presenta.)
"""
import argparse
import os
import re
import subprocess
import sys
import time

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PROC = "app"
BUNDLE = "io.armonia.topics.tauri"


def osa(script: str) -> str:
    return subprocess.run(["osascript", "-e", script],
                          capture_output=True, text=True).stdout.strip()


def frontmost() -> str:
    return osa('tell application "System Events" to get name of '
               'first process whose frontmost is true')


def activate() -> None:
    """Topics davanti, davvero. Esce se non ci riesce: vedi trappola 2."""
    for _ in range(8):
        osa(f'tell application id "{BUNDLE}" to activate')
        for _ in range(10):
            if frontmost() == PROC:
                return
            time.sleep(0.1)
    sys.exit("ERRORE: davanti c'e' %r, non Topics. Nessuna misura." % frontmost())


def rect() -> tuple[int, int, int, int]:
    """La finestra GRANDE, non `window 1`.

    Aprire una pane browser fa comparire altre finestre del processo (una era
    351x1215), e `window 1` allora punta a quella: i fotogrammi cambiavano
    formato a meta' registrazione e la misura si spezzava. La finestra della app
    e' la piu' larga, e quella si prende. Chi registra la blocca comunque una
    volta sola (vedi `fire`): una clip in cui l'inquadratura si sposta non
    confronta piu' niente.
    """
    out = osa(f'tell application "System Events" to tell process "{PROC}" '
              'to get {position, size} of every window')
    n = [int(v) for v in re.findall(r"-?\d+", out)]
    if len(n) < 4:
        sys.exit("ERRORE: nessuna finestra di Topics.")
    meta = len(n) // 2
    pos, size = n[:meta], n[meta:]
    best, area = None, -1
    for i in range(0, len(size) - 1, 2):
        w, h = size[i], size[i + 1]
        if w * h > area:
            area, best = w * h, (pos[i], pos[i + 1], w, h)
    return best


def shot(path: str, r: tuple[int, int, int, int] | None = None) -> tuple[int, int, int, int]:
    r = r or rect()
    subprocess.run(["/usr/sbin/screencapture", "-x", "-o",
                    "-R%d,%d,%d,%d" % r, path], check=True)
    return r


def click(gx: int, gy: int) -> None:
    """Click in coordinate GLOBALI. Il `=` e' la trappola 1, non un vezzo."""
    subprocess.run(["cliclick", "c:=%d,=%d" % (gx, gy)], check=True)
    time.sleep(0.25)


def type_text(text: str) -> None:
    osa('tell application "System Events" to keystroke %s' % json_str(text))


def json_str(s: str) -> str:
    return '"%s"' % s.replace("\\", "\\\\").replace('"', '\\"')


def cmd_r() -> None:
    osa('tell application "System Events" to keystroke "r" using command down')


def words(path: str) -> list[tuple[int, int, str, float]]:
    """Parole OCR con il centro gia' in coordinate GLOBALI."""
    ox, oy, _, _ = rect()
    tsv = subprocess.run(["tesseract", os.path.realpath(path), "-", "--psm", "6", "tsv"],
                         capture_output=True, text=True, errors="replace").stdout
    out = []
    for line in tsv.splitlines()[1:]:
        f = line.split("\t")
        if len(f) < 12 or not f[11].strip():
            continue
        conf = float(f[10])
        if conf < 35:
            continue
        left, top, w, h = (int(f[i]) for i in (6, 7, 8, 9))
        out.append((ox + left + w // 2, oy + top + h // 2, f[11], conf))
    return out


def tabs(path: str | None = None) -> list[tuple[int, int, str, float]]:
    """La striscia delle tab: i primi ~34px della finestra."""
    p = path or os.path.join(HERE, "out", "_tabs.png")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    activate()
    _, oy, _, _ = shot(p)
    return [w for w in words(p) if w[1] - oy <= 34]


def toast_visible(png: str, r: tuple[int, int, int, int]) -> str:
    """Il toast vive in `fixed bottom-4 right-4`, largo al massimo 20rem.
    Si ritaglia QUEL rettangolo e si legge: e' l'unico modo di non confondere
    il toast con la parola «Ricaricata» scritta su una card della board."""
    _, _, w, h = r
    im = Image.open(png).crop((w - 410, h - 125, w - 5, h - 8))
    im = im.resize((im.width * 3, im.height * 3), Image.LANCZOS)
    p = png[:-4] + "_toast.png"
    im.save(p)
    txt = subprocess.run(["tesseract", p, "-", "--psm", "7"],
                         capture_output=True, text=True, errors="replace").stdout
    return " ".join(txt.split())


def fire(args) -> int:
    out = os.path.join(HERE, "out", args.nome)
    os.makedirs(out, exist_ok=True)
    for old in os.listdir(out):
        os.remove(os.path.join(out, old))

    activate()
    if args.tab:
        hit = [t for t in tabs() if args.tab.lower() in t[2].lower()]
        if not hit:
            sys.exit("ERRORE: nessuna tab contiene %r" % args.tab)
        activate()
        click(hit[0][0], hit[0][1])
        time.sleep(2.0)

    r = rect()          # inquadratura BLOCCATA: vedi rect()
    activate()
    if args.into:
        gx, gy = (int(n) for n in args.into.split(","))
        click(gx, gy)
        time.sleep(0.6)
    if args.type:
        type_text(args.type)
        time.sleep(0.8)

    # Qualche fotogramma PRIMA del tasto: senza il «prima» il «dopo» non prova
    # niente, e la clip deve mostrare due stati, non uno.
    t0 = time.time()
    for i in range(6):
        time.sleep(max(0, t0 + i * 0.22 - time.time()))
        shot(os.path.join(out, "pre_%02d.png" % i), r)

    activate()
    cmd_r()
    t1 = time.time()
    n = int(args.secs / 0.22)
    for i in range(n):
        time.sleep(max(0, t1 + i * 0.22 - time.time()))
        shot(os.path.join(out, "post_%02d.png" % i), r)

    print("contesto %r - fotogrammi in %s" % (args.nome, out))
    visti = 0
    for i in range(n):
        p = os.path.join(out, "post_%02d.png" % i)
        txt = toast_visible(p, r)
        ok = "icaric" in txt.lower()
        visti += ok
        print("  t=%5.2fs  %s  %s" % (i * 0.22, "TOAST" if ok else "  .  ", txt[:44]))
    print("  fotogrammi con il toast: %d su %d" % (visti, n))
    return 0 if visti else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("tabs")
    f = sub.add_parser("fire")
    f.add_argument("nome")
    f.add_argument("--tab")
    f.add_argument("--into")
    f.add_argument("--type")
    f.add_argument("--secs", type=float, default=4.0)
    a = ap.parse_args()
    if a.cmd == "tabs":
        for gx, gy, t, c in tabs():
            print("x=%6d y=%6d conf=%3.0f  %s" % (gx, gy, c, t))
        return 0
    return fire(a)


if __name__ == "__main__":
    sys.exit(main())
