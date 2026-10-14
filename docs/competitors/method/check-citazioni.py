#!/usr/bin/env python3
"""Ogni [codice: percorso:riga] di un dossier deve esistere nel clone, con la riga dentro il file.
Esce 1 se un dossier ha meno del 95% di citazioni valide. Non dice se la frase è vera: dice se la fonte esiste."""
import re, subprocess, sys, pathlib, urllib.parse
R = pathlib.Path(__file__).parent
CIT = re.compile(r"\[codice:\s*([^\]]+?)\]")
LINK = re.compile(r"https://github\.com/([\w.-]+/[\w.-]+)/blob/([0-9a-f]{7,40})/([^\s)#\]`]+)(?:#L(\d+)(?:-L(\d+))?)?")
rc = 0
files = [pathlib.Path(a) for a in sys.argv[1:]] or sorted((R / "dossiers").glob("*.md"))
for d in files:
    slug = d.stem; repo = R / "repos" / slug
    if not repo.exists(): print(f"--    {slug}: nessun clone (dossier da documentazione)"); continue
    ok = bad = 0; esempi = []
    testo = d.read_text(encoding="utf-8")
    # Anche i link al codice del clone valgono come citazione: github.com/<owner>/<repo>/blob/<sha>/<percorso>#L<a>-L<b>.
    origin = subprocess.run(["git", "-C", str(repo), "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
    nome = re.sub(r"\.git$", "", re.sub(r"^.*github\.com[:/]", "", origin)).lower()
    for m in LINK.finditer(testo):
        if m.group(1).lower() != nome: continue
        path, a, b = urllib.parse.unquote(m.group(3)), m.group(4), m.group(5)
        r = subprocess.run(["git", "-C", str(repo), "show", f"HEAD:{path}"], capture_output=True)
        if r.returncode != 0:
            if (repo / path).is_dir(): ok += 1; continue
            bad += 1; esempi.append(f"manca {path}"); continue
        if a and int(b or a) > r.stdout.count(b"\n") + 1: bad += 1; esempi.append(f"{path}:{b or a} oltre il file"); continue
        ok += 1
    for m in CIT.finditer(testo):
        for parte in re.split(r"[;,]\s*(?=[\w./-]+\.\w+)", m.group(1)):
            mm = re.match(r"\s*([^\s:]+?)(?::(\d+)(?:-(\d+))?)?\s*$", parte)
            if not mm: continue
            path, a, b = mm.group(1).strip("`"), mm.group(2), mm.group(3)
            f = repo / path
            if not f.exists():
                hits = list(repo.rglob(pathlib.Path(path).name)) if "/" not in path else []
                f = hits[0] if len(hits) == 1 else f
            if f.is_dir() and not a: ok += 1; continue
            # Clone sparso: il file può stare nell'albero di HEAD senza essere sul disco.
            blob = None
            if not f.exists():
                r = subprocess.run(["git", "-C", str(repo), "show", f"HEAD:{path}"], capture_output=True)
                blob = r.stdout if r.returncode == 0 else None
            if blob is None and (not f.exists() or not f.is_file()): bad += 1; esempi.append(f"manca {path}"); continue
            if a:
                n = blob.count(b"\n") if blob is not None else sum(1 for _ in f.open(errors="ignore"))
                if int(b or a) > n: bad += 1; esempi.append(f"{path}:{b or a} oltre {n}"); continue
            ok += 1
    tot = ok + bad; pct = 100 * ok / tot if tot else 0
    stato = "OK  " if tot and pct >= 95 else "NO  "
    if stato == "NO  ": rc = 1
    print(f"{stato}  {slug}: {ok}/{tot} valide ({pct:.0f}%)" + (f" · es. {'; '.join(esempi[:3])}" if esempi else ""))
sys.exit(rc)
