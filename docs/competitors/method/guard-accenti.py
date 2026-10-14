# Accetta out.md solo se differisce da in.md per accenti, apostrofi e spazi:
# stesse righe, e codice tra backtick e URL identici byte per byte.
import difflib, re, sys, unicodedata

def norm(line):
    s = unicodedata.normalize("NFD", line)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"['’\s]", "", s)

def frozen(line):
    return re.findall(r"`[^`]*`|https?://\S+", line)

a = open(sys.argv[1], encoding="utf-8").read().rstrip("\n").split("\n")
b = open(sys.argv[2], encoding="utf-8").read().rstrip("\n").split("\n")
if len(a) != len(b):
    sys.exit(f"righe diverse: {len(a)} contro {len(b)}")
def same(x, y):
    # Ammessa anche l'elisione: «una app» diventa «un'app», una vocale in meno per apostrofo in più.
    nx, ny = norm(x), norm(y)
    if frozen(x) != frozen(y):
        return False
    if nx == ny:
        return True
    elided = 0
    for op, i1, i2, _, _ in difflib.SequenceMatcher(None, nx, ny, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        if op == "delete" and i2 - i1 == 1 and nx[i1] in "aeiouAEIOU":
            elided += 1
            continue
        return False
    return 0 < elided <= len(re.findall(r"['’]", y)) - len(re.findall(r"['’]", x))

bad = [i + 1 for i, (x, y) in enumerate(zip(a, b)) if not same(x, y)]
if bad:
    sys.exit(f"righe cambiate oltre accenti e apostrofi: {bad[:12]}")
print(f"ok: {sum(x != y for x, y in zip(a, b))} righe corrette su {len(a)}")
