#!/usr/bin/env bash
# Prepara il PC Windows a farsi misurare, e poi misura.
#
# Le 12 verifiche UI hanno bisogno di due cose VIVE sulla macchina Windows: il
# bundle dell'interfaccia servito su HTTP, e un Chrome headless con la porta di
# debug aperta. Le ho create a mano la prima volta; questo script le rifà da
# zero, così la misura è ripetibile da chiunque invece di dipendere da quello
# che è rimasto acceso su quel PC.
#
#   ./scripts/windows-ui-verify.sh [host]
#
# PERCHÉ NON SI MISURA L'APP DIRETTAMENTE. La sua interfaccia è compilata
# dentro `app.exe` e servita da `tauri://localhost`: non c'è nessuna porta da
# cui entrare. L'app è a istanza singola, quindi rilanciarla con
# `--remote-debugging-port` rientra nella finestra già viva (misurato: le
# istanze restano 1, il pid non cambia) e quella finestra è dell'utente, che
# non si tocca. Si misura allora lo STESSO codice: il bundle ricostruito dal
# commit del tag pubblicato, aperto in un browser vero SU WINDOWS — che è ciò
# che conta, perché lì il modificatore è Ctrl (etichette più larghe di ⌘), i
# font di sistema sono altri e la barra di scorrimento occupa spazio.
#
# DUE TRAPPOLE, entrambe misurate e entrambe curate qui:
#   · ssh uccide i propri figli quando la sessione si chiude. Server e Chrome
#     lanciati da ssh muoiono subito, e il sintomo è «il CDP non si alza» anche
#     quando era partito benissimo. Per questo girano come attività pianificate.
#   · la WebSocket "browser" di CDP rifiuta l'handshake attraverso un tunnel
#     (controlla l'`Origin`); quella della singola PAGINA lo accetta, ed è
#     l'unica che serve. Se ne occupa il driver.
set -euo pipefail

HOST="${1:-zorah@100.92.197.74}"
TAG="${TOPICS_WIN_TAG:-tauri-v2.2.176}"
PORTA_BUNDLE=8199
PORTA_CDP=9333
PORTA_CDP_LOCALE=9555
RADICE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAVORO="${TMPDIR:-/tmp}/topics-win-ui"

echo "==> 1/5 ricostruisco il bundle da $TAG (lo stesso codice dell'app installata)"
SHA="$(git -C "$RADICE" rev-parse --short "$TAG")"
rm -rf "$LAVORO/wt"
git -C "$RADICE" worktree remove --force "$LAVORO/wt" 2>/dev/null || true
git -C "$RADICE" worktree add -q "$LAVORO/wt" "$SHA"
ln -sfn "$RADICE/node_modules" "$LAVORO/wt/node_modules"
ln -sfn "$RADICE/client/node_modules" "$LAVORO/wt/client/node_modules" 2>/dev/null || true
(cd "$LAVORO/wt/client" && bun run build >/dev/null 2>&1)
echo "    bundle pronto da $SHA"

echo "==> 2/5 lo copio sul PC"
tar -czf "$LAVORO/ui.tgz" -C "$LAVORO/wt" public
scp -q "$LAVORO/ui.tgz" "$HOST:C:/Users/zorah/ui176.tgz"

echo "==> 3/5 preparo server del bundle e Chrome headless (attività pianificate)"
cat > "$LAVORO/srv.ps1" <<'PS'
$root = "C:\Users\zorah\ui176\public"
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://127.0.0.1:8199/")
$l.Start()
while ($l.IsListening) {
  try {
    $ctx = $l.GetContext()
    $p = $ctx.Request.Url.LocalPath.TrimStart("/")
    if ($p -eq "") { $p = "index.html" }
    $f = Join-Path $root $p
    if (-not (Test-Path $f -PathType Leaf)) { $f = Join-Path $root "index.html" }
    $bytes = [System.IO.File]::ReadAllBytes($f)
    $ct = switch ([System.IO.Path]::GetExtension($f)) {
      ".html" {"text/html"} ".js" {"application/javascript"} ".css" {"text/css"}
      ".svg" {"image/svg+xml"} ".json" {"application/json"} ".woff2" {"font/woff2"}
      default {"application/octet-stream"}
    }
    $ctx.Response.ContentType = $ct
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.Close()
  } catch { }
}
PS
cat > "$LAVORO/chrome.ps1" <<'PS'
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$prof = "C:\Users\zorah\ui176-prof"
if (Test-Path $prof) { Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue }
& $chrome --headless=new --disable-gpu --no-first-run --no-default-browser-check `
  --user-data-dir=$prof --window-size=1400,900 `
  --remote-debugging-port=9333 --remote-allow-origins=* about:blank
PS
cat > "$LAVORO/avvia.ps1" <<'PS'
# `Continue` e non `Stop`: `schtasks /Delete` di un'attivita' che non esiste
# scrive su stderr, e con `Stop` PowerShell lo tratta come eccezione fatale —
# cioe' lo script moriva proprio al primo avvio su una macchina pulita, che e'
# l'unico caso in cui deve funzionare per forza. Gli errori che contano davvero
# li riporta il controllo finale, che interroga le due porte.
$ErrorActionPreference = "Continue"
$dir = "C:\Users\zorah\ui176"
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
New-Item -ItemType Directory -Path $dir | Out-Null
tar -xzf C:\Users\zorah\ui176.tgz -C $dir
foreach ($t in @(
  @{ n = "topics-ui176-serve";  f = "C:\Users\zorah\srv.ps1" },
  @{ n = "topics-ui176-chrome"; f = "C:\Users\zorah\chrome.ps1" }
)) {
  schtasks /Delete /TN $t.n /F 2>$null | Out-Null
  schtasks /Create /TN $t.n /TR ("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " + $t.f) /SC ONCE /ST 00:00 /RL LIMITED /F | Out-Null
  schtasks /Run /TN $t.n | Out-Null
}
Start-Sleep -Seconds 9
$out = @()
try { $out += "bundle: " + (Invoke-WebRequest "http://127.0.0.1:8199/" -UseBasicParsing -TimeoutSec 8).StatusCode } catch { $out += "bundle NO: " + $_.Exception.Message }
try { $out += "cdp: " + (Invoke-WebRequest "http://127.0.0.1:9333/json/version" -UseBasicParsing -TimeoutSec 8).StatusCode } catch { $out += "cdp NO: " + $_.Exception.Message }
$out | Set-Content C:\Users\zorah\ui-avvio.txt -Encoding UTF8
PS
scp -q "$LAVORO/srv.ps1" "$HOST:C:/Users/zorah/srv.ps1"
scp -q "$LAVORO/chrome.ps1" "$HOST:C:/Users/zorah/chrome.ps1"
scp -q "$LAVORO/avvia.ps1" "$HOST:C:/Users/zorah/avvia.ps1"
ssh "$HOST" 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\zorah\avvia.ps1' >/dev/null 2>&1 || true
ssh "$HOST" 'type C:\Users\zorah\ui-avvio.txt' 2>/dev/null | sed 's/^/    /'

echo "==> 4/5 apro i tunnel"
pkill -f "L ${PORTA_CDP_LOCALE}:127.0.0.1:${PORTA_CDP}" 2>/dev/null || true
pkill -f "L ${PORTA_BUNDLE}:127.0.0.1:${PORTA_BUNDLE}" 2>/dev/null || true
sleep 1
ssh -o ExitOnForwardFailure=yes -f -N \
  -L "${PORTA_CDP_LOCALE}:127.0.0.1:${PORTA_CDP}" \
  -L "${PORTA_BUNDLE}:127.0.0.1:${PORTA_BUNDLE}" "$HOST" 2>/dev/null || true
sleep 2

echo "==> 5/5 misuro"
cd "$RADICE"
TOPICS_WIN_CDP="http://127.0.0.1:${PORTA_CDP_LOCALE}" \
TOPICS_WIN_UI="http://127.0.0.1:${PORTA_BUNDLE}/" \
  bun run tests/manual/run-ui12-windows.ts
