# WHY THE BROWSER PANE SHOWS NOTHING ON WINDOWS. The instrument that answers with
# something other than pixels.
#
# `win-desktop-check.ps1` (e) reads the pane through `PrintWindow`, and on
# 2.2.287 it reads a window that never changes: the capture taken 13s and two
# navigations after the pane opened is byte-identical to the one taken the
# instant it appeared. That reading has two possible causes and pixels alone
# cannot separate them:
#   PANE DEAD    the native WebView2 child never renders and never navigates.
#   GATE BLIND   the pane works and `PrintWindow` cannot see a second WebView2.
#
# So this probe asks three questions at once, on the same pane, in one run:
#   1. HWND    does a WebView2 child window exist under the top-level window,
#              which process owns it, where is it, is it visible.
#   2. WITNESS a TCP listener of our own, on a port the app does not use, logs
#              every request it receives with its User-Agent. A request arriving
#              is proof the pane navigated that no screenshot can give, and the
#              User-Agent says WHO navigated: `Edg/` is the native WebView2 of
#              the pane, `HeadlessChrome` is the server-side Playwright context.
#   3. CAPTURE the same instant, twice: `PrintWindow(hwnd, dc, 2)` (what the gate
#              does) and a real screen grab. If they disagree, the gate is blind.
#
# Run it ON the Windows machine inside a scheduled task registered with `/it`,
# exactly like the gate: from an ssh session the console user's windows do not
# exist. The driver next to this file (`win-browser-probe.sh`) does that and
# brings the artefacts back.
#
#   powershell -File win-browser-probe.ps1 -Out C:\...\out -Label probe
#
# It leaves the app running with the pane closed and no listener behind.
param(
  [string]$Out = "$env:TEMP\topics-win-probe",
  [string]$Label = "probe",
  [string]$ProcName = "app",
  # Not 13333: that is the app's own server. This port has to be one nothing
  # else answers on, or a request in the log would prove nothing.
  [int]$Port = 13444,
  # Where the pane's address bar sits, as a fraction of the window, for the
  # mouse arm. Measured on `05-browser-pane-blank.png` of the 2.2.287 run: the
  # new-tab page centres its search field.
  [double]$BarX = 0.613,
  [double]$BarY = 0.504,
  # Internal: run as the TCP witness instead of as the probe.
  [switch]$Witness
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$witnessLog = Join-Path $Out "witness-$Label.log"
$stopFile = Join-Path $Out "witness-$Label.stop"

# ------------------------------------------------------------------ witness --
# A TcpListener and not an HttpListener: the second one needs a URL reservation
# (or an elevated process) for its prefix, and a probe that fails on an ACL
# would look exactly like a pane that never navigated. Minimal HTTP by hand is
# cheaper than that ambiguity. The page it serves is solid red end to end, so a
# screen capture of a window that loaded it cannot be mistaken for a blank one.
if ($Witness) {
  $body = "<!doctype html><html><head><meta charset=utf-8><title>witness</title></head>" +
    "<body style='margin:0;background:#e00'><div style='height:100vh;display:flex;" +
    "align-items:center;justify-content:center;font:700 64px sans-serif;color:#fff'>WITNESS</div></body></html>"
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
  $listener.Start()
  "listening on 127.0.0.1:$Port at $(Get-Date -Format o)" | Add-Content $witnessLog
  $deadline = (Get-Date).AddSeconds(240)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $stopFile)) {
    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 120; continue }
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $stream.ReadTimeout = 2000
      $buf = New-Object byte[] 4096
      $read = 0
      try { $read = $stream.Read($buf, 0, $buf.Length) } catch { $read = 0 }
      $req = [Text.Encoding]::ASCII.GetString($buf, 0, [Math]::Max($read, 0))
      $first = ($req -split "`r`n")[0]
      $ua = ""
      foreach ($line in ($req -split "`r`n")) { if ($line -match "^User-Agent:\s*(.+)$") { $ua = $Matches[1] } }
      "$(Get-Date -Format HH:mm:ss.fff)  $first  UA=$ua" | Add-Content $witnessLog
      $head = "HTTP/1.1 200 OK`r`nContent-Type: text/html; charset=utf-8`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
      $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
      $stream.Write($headBytes, 0, $headBytes.Length)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
    } catch {
      "$(Get-Date -Format HH:mm:ss.fff)  ERROR $($_.Exception.Message)" | Add-Content $witnessLog
    } finally { $client.Close() }
  }
  $listener.Stop()
  "stopped at $(Get-Date -Format o)" | Add-Content $witnessLog
  exit 0
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class BrowserProbe {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@

$logPath = Join-Path $Out "browser-probe-$Label.log"
$lines = @()
function Say($text) {
  $script:lines += $text
  $script:lines -join "`n" | Set-Content $logPath
  Write-Output $text
}

function Find-AppWindow($procName) {
  $script:found = [IntPtr]::Zero
  $script:best = 0
  $cb = [BrowserProbe+EnumProc]{ param($h, $l)
    $owner = 0
    [BrowserProbe]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
    $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq $procName -and [BrowserProbe]::IsWindowVisible($h)) {
      $r = New-Object BrowserProbe+RECT
      [BrowserProbe]::GetWindowRect($h, [ref]$r) | Out-Null
      $area = ($r.R - $r.L) * ($r.B - $r.T)
      if ($area -gt $script:best) { $script:best = $area; $script:found = $h }
    }
    return $true
  }
  [BrowserProbe]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:found
}

# The child window tree, in z-order as EnumChildWindows walks it (topmost
# first). A WebView2 shows up as `Chrome_WidgetWin_*` owned by
# msedgewebview2.exe: one of those is the app's own UI, a SECOND one is the
# pane. Which process owns each child is the part that names them apart.
function Dump-Children($h, $tag) {
  $script:kids = @()
  $cb = [BrowserProbe+EnumProc]{ param($c, $l)
    $sb = New-Object Text.StringBuilder 256
    [BrowserProbe]::GetClassName($c, $sb, 256) | Out-Null
    $r = New-Object BrowserProbe+RECT
    [BrowserProbe]::GetWindowRect($c, [ref]$r) | Out-Null
    $owner = 0
    [BrowserProbe]::GetWindowThreadProcessId($c, [ref]$owner) | Out-Null
    $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
    $script:kids += [pscustomobject]@{
      Handle = $c; Class = $sb.ToString(); Pid = $owner
      Proc = $(if ($p) { $p.ProcessName } else { "?" })
      Rect = "$($r.L),$($r.T) $($r.R - $r.L)x$($r.B - $r.T)"
      Visible = [BrowserProbe]::IsWindowVisible($c)
    }
    return $true
  }
  [BrowserProbe]::EnumChildWindows($h, $cb, [IntPtr]::Zero) | Out-Null
  Say "-- children $tag : $($script:kids.Count)"
  foreach ($k in $script:kids) {
    Say ("   {0,-30} pid={1,-6} {2,-16} {3,-20} visible={4}" -f $k.Class, $k.Pid, $k.Proc, $k.Rect, $k.Visible)
  }
  return $script:kids
}

function Focus($h) {
  [BrowserProbe]::ShowWindow($h, 9) | Out-Null
  for ($try = 1; $try -le 5; $try++) {
    if ([BrowserProbe]::GetForegroundWindow() -eq $h) { Start-Sleep -Milliseconds 300; return $true }
    [BrowserProbe]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
    [BrowserProbe]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    [BrowserProbe]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 400
  }
  return ([BrowserProbe]::GetForegroundWindow() -eq $h)
}

function Send($keys) {
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Milliseconds 900
}

function Rect($h) {
  $r = New-Object BrowserProbe+RECT
  [BrowserProbe]::GetWindowRect($h, [ref]$r) | Out-Null
  return $r
}

# Both captures of the same window, at the same moment, one file each. Their
# average luminance and their file size are enough to tell "the same picture"
# from "two different pictures": the page the witness serves is solid red, which
# no window chrome of this app resembles.
function Capture($h, $stem) {
  $r = Rect $h
  $w = $r.R - $r.L
  $ht = $r.B - $r.T
  if ($w -lt 200 -or $ht -lt 200) { Say "!! window too small to capture: ${w}x${ht}"; return }
  foreach ($how in @("print", "screen")) {
    $bmp = New-Object System.Drawing.Bitmap $w, $ht
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    if ($how -eq "print") {
      $dc = $g.GetHdc()
      $ok = [BrowserProbe]::PrintWindow($h, $dc, 2)
      $g.ReleaseHdc($dc)
      if (-not $ok) { Say "!! PrintWindow refused for $stem" }
    } else {
      $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $ht)))
    }
    $g.Dispose()
    $path = Join-Path $Out "$stem-$how.png"
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    # Mean red channel and mean luminance over a coarse grid: the witness page is
    # red on white chrome, so "did red arrive" is a number, not an impression.
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $ht
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $bytes = New-Object byte[] ($stride * $ht)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    $bmp.UnlockBits($data)
    $sumLum = 0.0; $reddish = 0; $n = 0
    for ($y = 8; $y -lt $ht - 8; $y += 12) {
      $base = $y * $stride
      for ($x = 12; $x -lt $w - 12; $x += 6) {
        $p = $base + $x * 4
        $b = $bytes[$p]; $gr = $bytes[$p + 1]; $rd = $bytes[$p + 2]
        $sumLum += (299 * $rd + 587 * $gr + 114 * $b) / 1000
        if ($rd -gt 120 -and $rd - $gr -gt 60 -and $rd - $b -gt 60) { $reddish++ }
        $n++
      }
    }
    $bmp.Dispose()
    $meanLum = if ($n -gt 0) { [Math]::Round($sumLum / $n, 1) } else { -1 }
    $redPct = if ($n -gt 0) { [Math]::Round(100 * $reddish / $n, 1) } else { -1 }
    Say ("   capture {0,-22} {1,-6} lum={2,-7} red={3}%  ({4} bytes)" -f $stem, $how, $meanLum, $redPct, (Get-Item $path).Length)
  }
}

function Click($h, $fx, $fy) {
  $r = Rect $h
  $x = [int]($r.L + ($r.R - $r.L) * $fx)
  $y = [int]($r.T + ($r.B - $r.T) * $fy)
  [BrowserProbe]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 200
  [BrowserProbe]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero)   # left down
  [BrowserProbe]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero)   # left up
  Start-Sleep -Milliseconds 400
  Say "-- clicked at $x,$y (fraction $fx,$fy)"
}

function WitnessHits {
  if (-not (Test-Path $witnessLog)) { return @() }
  return @(Get-Content $witnessLog | Where-Object { $_ -match "GET " })
}

function Webview2Processes($tag) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue
  $mine = @($procs | Where-Object { $_.CommandLine -and $_.CommandLine -match "io\.armonia\.topics\.tauri" })
  $stores = @($mine | Where-Object { $_.CommandLine -match "browser-stores" })
  $renderers = @($stores | Where-Object { $_.CommandLine -match "--type=renderer" })
  $gpus = @($stores | Where-Object { $_.CommandLine -match "--type=gpu-process" })
  Say "-- webview2 $tag : app total $($mine.Count), pane store $($stores.Count) (renderer $($renderers.Count), gpu $($gpus.Count))"
  foreach ($p in $stores) {
    $store = ""
    if ($p.CommandLine -match "browser-stores.([0-9a-f-]{36})") { $store = $Matches[1] }
    $type = "browser"
    if ($p.CommandLine -match "--type=([a-z-]+)") { $type = $Matches[1] }
    Say "   pid=$($p.ProcessId) type=$type store=$store"
  }
}

# --------------------------------------------------------------------- run ---

Say "== topics windows browser probe, label $Label, port $Port"
Remove-Item $stopFile -ErrorAction SilentlyContinue
Remove-Item $witnessLog -ErrorAction SilentlyContinue

$witnessProc = Start-Process powershell -PassThru -WindowStyle Hidden -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath,
  "-Witness", "-Port", $Port, "-Out", $Out, "-Label", $Label
)
Start-Sleep 2

# THE WITNESS IS TESTED BEFORE IT IS TRUSTED. A listener that never came up
# would answer "the pane did not navigate" for every arm, which is the exact
# wrong answer this probe exists to avoid.
try {
  $c = New-Object Net.Sockets.TcpClient("127.0.0.1", $Port)
  $s = $c.GetStream()
  $req = [Text.Encoding]::ASCII.GetBytes("GET /probe-selftest HTTP/1.1`r`nHost: 127.0.0.1:$Port`r`nUser-Agent: probe-selftest`r`nConnection: close`r`n`r`n")
  $s.Write($req, 0, $req.Length)
  $s.Flush()
  Start-Sleep -Milliseconds 400
  $c.Close()
  Say "-- witness selftest: $(@(WitnessHits).Count) request(s) logged (want 1)"
} catch {
  Say "!! witness selftest failed: $($_.Exception.Message)"
}
if (@(WitnessHits).Count -lt 1) { Say "FAIL the witness never answered: nothing below would mean anything"; exit 2 }

$h = Find-AppWindow $ProcName
if ($h -eq [IntPtr]::Zero) { Say "FAIL no visible window for process $ProcName"; exit 2 }
$r = Rect $h
Say "window $h at $($r.L),$($r.T) $($r.R - $r.L)x$($r.B - $r.T)"
if (-not (Focus $h)) { Say "!! the window refused the foreground: the screen capture may show something else" }

Dump-Children $h "before the pane" | Out-Null
Webview2Processes "before the pane"
Capture $h "20-before-pane"

# Ctrl+N then the bare letter B: the frozen mnemonic for a new browser pane.
Send "^n"
Send "b"
Start-Sleep 6
$kidsAfter = Dump-Children $h "with the pane open"
Webview2Processes "with the pane open"
Capture $h "21-pane-open"

# Arm 1: the keyboard, exactly as the gate does it.
Send "^l"
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("http://127.0.0.1:$Port/probe-keyboard{ENTER}")
Start-Sleep 7
$hitsAfterKeyboard = @(WitnessHits).Count
Say "-- after the keyboard arm: $hitsAfterKeyboard request(s) total"
Dump-Children $h "after the keyboard arm" | Out-Null
Capture $h "22-after-keyboard"

# Arm 2: the mouse, in case the keyboard never reached the client. Clicking the
# address bar first removes the focus question from the reading.
Focus $h | Out-Null
Click $h $BarX $BarY
[System.Windows.Forms.SendKeys]::SendWait("http://127.0.0.1:$Port/probe-mouse{ENTER}")
Start-Sleep 7
$hitsAfterMouse = @(WitnessHits).Count
Say "-- after the mouse arm: $hitsAfterMouse request(s) total"
Dump-Children $h "after the mouse arm" | Out-Null
Webview2Processes "after the mouse arm"
Capture $h "23-after-mouse"

Say "== witness log =="
foreach ($line in (Get-Content $witnessLog)) { Say "   $line" }

# Leave the machine as it was found: pane closed, listener stopped.
Send "^w"
Start-Sleep 1
Dump-Children $h "after closing the pane" | Out-Null
New-Item -ItemType File -Force -Path $stopFile | Out-Null
Start-Sleep 1
if ($witnessProc -and -not $witnessProc.HasExited) { Stop-Process -Id $witnessProc.Id -Force -ErrorAction SilentlyContinue }
Say "== done"
exit 0
