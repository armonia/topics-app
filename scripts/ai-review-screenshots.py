#!/usr/bin/env python3
"""AI visual review of E2E test screenshots — delegates to OpenClaw gateway.

Convenzione dei nomi:
  <soggetto>-BEFORE-<verbo>.png + <soggetto>-AFTER-<verbo>.png  → una COPPIA
  <qualsiasi altro nome>.png                                    → un SINGOLO

Il verbo deve essere LO STESSO nei due scatti, altrimenti non c'è nessuna
coppia: sono due mezze coppie. Uno scatto che rappresenta uno stato a sé
(non una transizione) NON va marcato BEFORE/AFTER — va chiamato per quello
che è, e finisce fra i singoli.
"""

import json, os, glob

RESULTS_DIR = os.path.join(os.environ.get("PROJECT_DIR", "."), "test-results")
OUTPUT_FILE = os.path.join(RESULTS_DIR, "ai-review.json")

def main():
    screenshots = sorted(glob.glob(os.path.join(RESULTS_DIR, "*.png")))
    if not screenshots:
        print("No screenshots found — skipping AI review")
        json.dump({"screenshots": [], "summary": {"total": 0}}, open(OUTPUT_FILE, "w"))
        return

    # Group BEFORE/AFTER pairs
    groups = {}
    singles = []
    for img in screenshots:
        base = os.path.basename(img).replace(".png", "")
        if "-BEFORE-" in base:
            groups.setdefault(base.replace("-BEFORE-", "-"), {})["before"] = img
        elif "-AFTER-" in base:
            groups.setdefault(base.replace("-AFTER-", "-"), {})["after"] = img
        else:
            singles.append(img)

    # Una mezza coppia NON si butta e NON si conta come coppia.
    #
    # Prima il manifest teneva `pairs` filtrato sulle coppie complete ma contava
    # `total = len(singles) + len(groups)`, cioè contava anche i gruppi a metà:
    # annunciava «9 screenshot pronti» e ne consegnava 7, con 4 scatti spariti
    # senza una riga di avviso. Il caso non era teorico — bastava che due spec
    # usassero verbi diversi per lo stesso movimento (BEFORE-open / AFTER-closed)
    # perché nessuno dei due trovasse il suo compagno.
    #
    # Ora: le complete diventano coppie, le mezze finiscono fra i singoli (uno
    # scatto orfano resta comunque guardabile) e vengono NOMINATE a schermo, così
    # una convenzione rotta si vede subito invece di degradare in silenzio.
    pairs = [{"key": k, **v} for k, v in groups.items() if "before" in v and "after" in v]
    orphans = {k: v for k, v in groups.items() if len(v) == 1}
    for k, v in sorted(orphans.items()):
        singles.append(next(iter(v.values())))
    singles.sort()

    total = len(pairs) + len(singles)

    manifest = {
        "pairs": pairs,
        "singles": singles,
        "unpaired": sorted(orphans.keys()),
        "total": total,
        "status": "pending_review",
    }
    json.dump(manifest, open(OUTPUT_FILE, "w"), indent=2)
    print(f"AI Review: {total} screenshots ready for review via OpenClaw")
    print(f"  {len(pairs)} pairs + {len(singles)} singles")
    if orphans:
        print(f"  ⚠ {len(orphans)} mezze coppie (verbo BEFORE/AFTER non appaiato), riviste come singoli:")
        for k, v in sorted(orphans.items()):
            print(f"      {k} — manca il {'AFTER' if 'before' in v else 'BEFORE'}")
    print(f"  Run: ask Jarvis to review test-results/ai-review.json")

if __name__ == "__main__":
    main()
