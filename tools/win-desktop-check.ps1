# DOES THE PUBLISHED WINDOWS BUILD WORK ON A REAL DESKTOP? The gate that answers,
# with a number per question and a non-zero exit at the first FAIL.
#
# Run it ON the Windows machine, inside a scheduled task registered with `/it`
# (LogonType Interactive). From an ssh session the console user's windows do not
# exist: EnumWindows returns nothing, PrintWindow gives back an empty bitmap,
# SendKeys types into a desktop nobody can see and Start-Process opens a window
# on another window station. The driver next to this file
# (`win-desktop-check.sh`) registers and runs that task for you and brings the
# artefacts back.
#
#   powershell -File win-desktop-check.ps1 -Out C:\...\out -Label run
#
# THE FIVE QUESTIONS, in the order they are asked:
#   a  boot: how long from launch to a shell that answers and a window that has
#      drawn. Reported as two seconds figures plus the branch the shell took.
#   b  chrome: the three Windows command cells and the wordmark next to them,
#      measured in the pixels of the window itself, against the geometry
#      declared in `client/src/lib/shell/windowControlsGeometry.ts`.
#   c  shortcuts: Ctrl+K, Ctrl+N and Ctrl+W actually do something, and the
#      something goes away again.
#   d  minimise and restore: the webview comes back painted.
#   e  a WebView2 browser pane opens, navigates twice and closes.
#
# HOW A "SOMETHING HAPPENED" IS MEASURED. Two readings on captures of the window
# taken through PrintWindow, both copied from `win-restore-check.ps1` where they
# were established:
#   ink   rows carrying a luminance step above 24 between neighbouring samples.
#         A flat grey wash is as neutral as an interface, so counting neutral
#         pixels cannot tell a blank window from a full one. Edges can.
#   diff  fraction of samples that moved by more than 24 between two captures.
#
# THE THREE FALSIFICATION ARMS. A gate that cannot fail is not measuring:
#   -NoRemedy             relaunch with TOPICS_NO_WEBVIEW_REBUILD=1, which turns
#                         off the cure for the restore defect. This is a REAL
#                         lever on the subject of (d): it must exit 1.
#   (no flag, on a box     with the `external-server-seen` marker in place the
#    with the marker)      shell never starts a server: (a) fails on its own,
#                          with nothing faked. That is the honest arm for (a).
#   -WrongKey             sends an UNBOUND combination in place of Ctrl+K. It
#                         proves the probe can tell "the overlay opened" from
#                         "nothing happened": it is a discrimination test of the
#                         MEASUREMENT, not a lever on the shortcut itself. Said
#                         plainly because calling it more would be a lie.
# There is no honest arm for (b) and (e): the geometry and the pane both live
# inside the shipped bundle and nothing here can move them without editing the
# expectation, which would be marking my own homework.
param(
  [string]$Out = "$env:TEMP\topics-win-check",
  [string]$Label = "run",
  [string]$ProcName = "app",
  # Move `external-server-seen` aside before relaunching. This is exactly what
  # the button in the degraded panel does (`clearBootDegraded`), and on a box
  # that once ran a real server it is the difference between measuring the boot
  # and measuring a machine that refuses to boot.
  [switch]$ClearDegradedMarker,
  [switch]$NoRemedy,
  [switch]$WrongKey,
  # Which of the five to run, as letters. The default is all of them; a subset
  # is how a report gets the numbers of the checks that come AFTER a known
  # failure, since the gate stops at the first FAIL by design. It is not a way
  # to make a run green: the letters you asked for are printed in the log.
  [string]$Only = "abcde",
  [int]$BootTimeoutSec = 45,
  # Time given to the webview after a restore before B is captured. The remedy
  # rebuilds the webview, which reloads the page.
  [int]$SettleMs = 4000
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;using System.Runtime.InteropServices;
public class DesktopCheck {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
}
"@

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$logPath = Join-Path $Out "desktop-check-$Label.log"
$lines = @()
function Say($text) {
  $script:lines += $text
  $script:lines -join "`n" | Set-Content $logPath
  Write-Output $text
}
$failures = 0
# Every verdict prints its measure, passing or failing: a green line with no
# number in it is a claim, not a reading.
function Verdict($ok, $letter, $measure) {
  $tag = if ($ok) { "PASS" } else { "FAIL" }
  Say "$tag $letter  $measure"
  if (-not $ok) {
    $script:failures++
    Say "-- stopping at the first FAIL"
    Cleanup
    exit 1
  }
}
function Cleanup {
  Remove-Item Env:\TOPICS_NO_WEBVIEW_REBUILD -ErrorAction SilentlyContinue
}

function Wants($letter) { return $Only.Contains($letter) }

$exePath = Join-Path $env:LOCALAPPDATA "Topics\$ProcName.exe"
$markerPath = Join-Path $env:APPDATA "io.armonia.topics.tauri\external-server-seen"

# ---------------------------------------------------------------- capture ---

# Largest visible top-level window owned by the app process.
function Find-AppWindow($procName) {
  $script:found = [IntPtr]::Zero
  $script:best = 0
  $cb = [DesktopCheck+EnumProc]{ param($h, $l)
    $owner = 0
    [DesktopCheck]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
    $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq $procName -and [DesktopCheck]::IsWindowVisible($h)) {
      $r = New-Object DesktopCheck+RECT
      [DesktopCheck]::GetWindowRect($h, [ref]$r) | Out-Null
      $area = ($r.R - $r.L) * ($r.B - $r.T)
      if ($area -gt $script:best) { $script:best = $area; $script:found = $h }
    }
    return $true
  }
  [DesktopCheck]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:found
}

# The window's OWN buffer, via PrintWindow with PW_RENDERFULLCONTENT: it reads
# what the window drew even when something covers it, which CopyFromScreen
# cannot. Returns the bitmap AND a coarse luminance grid, so the readings below
# all sample the same pixels.
function Grab($h, $pngPath) {
  $r = New-Object DesktopCheck+RECT
  [DesktopCheck]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.R - $r.L
  $ht = $r.B - $r.T
  if ($w -lt 200 -or $ht -lt 200) { return $null }
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  $drew = [DesktopCheck]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc)
  $g.Dispose()
  if (-not $drew) { $bmp.Dispose(); return $null }
  if ($pngPath) { $bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png) }

  # One LockBits pass into a byte array: GetPixel per sample is minutes, this is
  # milliseconds.
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $ht
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $bytes = New-Object byte[] ($stride * $ht)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($data)

  $grid = New-Object 'System.Collections.Generic.List[int[]]'
  for ($y = 8; $y -lt $ht - 8; $y += 12) {
    $row = New-Object 'System.Collections.Generic.List[int]'
    $base = $y * $stride
    for ($x = 12; $x -lt $w - 12; $x += 3) {
      $p = $base + $x * 4
      $lum = [int]((299 * $bytes[$p + 2] + 587 * $bytes[$p + 1] + 114 * $bytes[$p]) / 1000)
      $row.Add($lum)
    }
    $grid.Add($row.ToArray())
  }
  return [pscustomobject]@{ Grid = $grid; Width = $w; Height = $ht; Bitmap = $bmp; Bytes = $bytes; Stride = $stride }
}

function Release($shot) {
  if ($shot -and $shot.Bitmap) { $shot.Bitmap.Dispose() }
}

function Ink($shot) {
  if ($null -eq $shot) { return $null }
  $inked = 0
  foreach ($row in $shot.Grid) {
    $prev = -1
    foreach ($lum in $row) {
      if ($prev -ge 0 -and [Math]::Abs($lum - $prev) -gt 24) { $inked++; break }
      $prev = $lum
    }
  }
  return [pscustomobject]@{ Inked = $inked; Rows = $shot.Grid.Count }
}

function InkPercent($shot) {
  $i = Ink $shot
  if ($null -eq $i -or $i.Rows -eq 0) { return -1 }
  return [Math]::Round(100 * $i.Inked / $i.Rows, 1)
}

function DiffRatio($a, $b) {
  if ($null -eq $a -or $null -eq $b) { return $null }
  if ($a.Width -ne $b.Width -or $a.Height -ne $b.Height) { return $null }
  $moved = 0
  $total = 0
  for ($i = 0; $i -lt $a.Grid.Count; $i++) {
    $ra = $a.Grid[$i]
    $rb = $b.Grid[$i]
    for ($j = 0; $j -lt $ra.Length; $j++) {
      $total++
      if ([Math]::Abs($ra[$j] - $rb[$j]) -gt 24) { $moved++ }
    }
  }
  if ($total -eq 0) { return $null }
  return [Math]::Round($moved / $total, 4)
}

function Pct($ratio) {
  if ($null -eq $ratio) { return "n/a" }
  return "$([Math]::Round($ratio * 100, 1))%"
}

# BRING THE WINDOW TO THE FRONT, AND SAY SO IF IT DID NOT COME.
#
# `SetForegroundWindow` is refused when the calling process is not itself the
# foreground one: Windows answers false and nothing moves. Keys then go to
# whatever DOES have the focus, and every keyboard reading below becomes a
# measurement of the wrong window that still prints a number. Measured here: the
# same probe read 60% for Ctrl+K right after launching the app, and 0% for every
# shortcut when the app had been sitting idle. Tapping ALT releases the
# foreground lock for this thread, which is the documented way in.
function Focus($h) {
  [DesktopCheck]::ShowWindow($h, 9) | Out-Null
  for ($try = 1; $try -le 5; $try++) {
    if ([DesktopCheck]::GetForegroundWindow() -eq $h) { Start-Sleep -Milliseconds 300; return $true }
    [DesktopCheck]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)       # ALT down
    [DesktopCheck]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)       # ALT up
    [DesktopCheck]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 400
  }
  return ([DesktopCheck]::GetForegroundWindow() -eq $h)
}

function Send($keys) {
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Milliseconds 900
}

# Escape, then look, then Escape once more. TWO is not generosity: the first key
# can arrive while the overlay is still animating in, and a probe that reads a
# menu still on screen would call a working dismissal broken. The number of
# escapes it took is REPORTED, so a second one that becomes the rule stops being
# invisible.
function Dismiss($h, $baseline, $png) {
  $escapes = 0
  $diff = $null
  for ($try = 1; $try -le 2; $try++) {
    Send "{ESC}"
    $escapes++
    $shot = Grab $h $png
    $diff = DiffRatio $baseline $shot
    Release $shot
    if (($null -ne $diff) -and $diff -lt 0.015) { break }
  }
  return [pscustomobject]@{ Diff = $diff; Escapes = $escapes }
}

# ------------------------------------------------------------------- (a) ----

Say "== topics windows desktop check, label $Label, checks [$Only]"
if (-not (Test-Path $exePath)) { Say "NO EXE at $exePath"; exit 2 }
$installed = (Get-Item $exePath).VersionInfo.FileVersion
Say "installed $installed"

foreach ($name in @($ProcName, "topics-server")) {
  Get-Process $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep 3

$markerWas = Test-Path $markerPath
if ($ClearDegradedMarker -and $markerWas) {
  Move-Item $markerPath "$markerPath.bak" -Force
  Say "marker moved aside: external-server-seen -> .bak"
}
if ($NoRemedy) {
  $env:TOPICS_NO_WEBVIEW_REBUILD = "1"
  Say "arm: webview rebuild remedy OFF"
} else {
  Remove-Item Env:\TOPICS_NO_WEBVIEW_REBUILD -ErrorAction SilentlyContinue
}

$t0 = Get-Date
Start-Process $exePath | Out-Null
$tServe = $null
$tPaint = $null
$h = [IntPtr]::Zero
$deadline = $t0.AddSeconds($BootTimeoutSec)
while ((Get-Date) -lt $deadline) {
  if ($null -eq $tServe) {
    try {
      $resp = Invoke-WebRequest -Uri "http://127.0.0.1:13333/" -UseBasicParsing -TimeoutSec 2
      # The shell answers on this port in BOTH states: with a real upstream it
      # proxies the client bundle, without one it serves its own reconnect page.
      # The body is what tells them apart, so the reading cannot call a degraded
      # shell "connected" just because something replied.
      if ($resp.StatusCode -eq 200 -and $resp.Content -notmatch "waits for that one" -and $resp.Content -match "assets/") {
        $tServe = ((Get-Date) - $t0).TotalSeconds
      }
    } catch { }
  }
  if ($null -eq $tPaint) {
    if ($h -eq [IntPtr]::Zero) { $h = Find-AppWindow $ProcName }
    if ($h -ne [IntPtr]::Zero) {
      $shot = Grab $h $null
      $paintInk = InkPercent $shot
      Release $shot
      # 15%, not "most of the window": how much ink a healthy Topics window
      # carries depends on what it restored. Measured on this build, same
      # window, same session: 100% with the sidebar list open, 23% with a
      # browser pane showing an empty new tab. A window that is not painting
      # reads 1.3% (1 row out of 77), so the two are still far apart, and a
      # threshold tuned to the busy case would call the quiet one broken.
      if ($paintInk -ge 15) { $tPaint = ((Get-Date) - $t0).TotalSeconds }
    }
  }
  if ($null -ne $tServe -and $null -ne $tPaint) { break }
  Start-Sleep -Milliseconds 400
}

$sidecar = (Get-Process topics-server -ErrorAction SilentlyContinue | Measure-Object).Count
$branch = "marker=$(if (Test-Path $markerPath) { 'present' } else { 'absent' }) sidecar=$sidecar"
$serveTxt = if ($null -ne $tServe) { "$([Math]::Round($tServe, 1))s" } else { ">$($BootTimeoutSec)s" }
$paintTxt = if ($null -ne $tPaint) { "$([Math]::Round($tPaint, 1))s" } else { ">$($BootTimeoutSec)s" }
$paintTxt = "$paintTxt (ink $paintInk%)"
if ($h -eq [IntPtr]::Zero) { $h = Find-AppWindow $ProcName }
if ($h -ne [IntPtr]::Zero) {
  $first = Grab $h (Join-Path $Out "01-first-launch-$Label.png")
  Release $first
}
Verdict (($null -ne $tServe) -and ($null -ne $tPaint)) "a" "boot: client bundle served at $serveTxt, window painted at $paintTxt, budget ${BootTimeoutSec}s ($branch)"

if ($h -eq [IntPtr]::Zero) { Verdict $false "a" "no window for process '$ProcName'" }
Focus $h | Out-Null

# ------------------------------------------------------------------- (b) ----
# The chrome is measured in the CLIENT area, because that is the box the CSS
# numbers are relative to, and scaled by the window's own DPI: 72 CSS px is not
# 72 device px on a scaled display.
if (Wants 'b') {

  $dpi = [DesktopCheck]::GetDpiForWindow($h)
  $scale = $dpi / 96.0
  $wr = New-Object DesktopCheck+RECT
  $cr = New-Object DesktopCheck+RECT
  [DesktopCheck]::GetWindowRect($h, [ref]$wr) | Out-Null
  [DesktopCheck]::GetClientRect($h, [ref]$cr) | Out-Null
  $origin = New-Object DesktopCheck+POINT
  [DesktopCheck]::ClientToScreen($h, [ref]$origin) | Out-Null
  $offX = $origin.X - $wr.L
  $offY = $origin.Y - $wr.T
  Say "window $(($wr.R - $wr.L))x$(($wr.B - $wr.T)) dpi $dpi scale $scale client offset $offX,$offY"

  $chrome = Grab $h $null
  if ($null -eq $chrome) { Verdict $false "b" "could not capture the window" }

  # Column ink profile over the title band: for each column, the luminance spread
  # across the band. Text, icons and frames have a spread; a fill does not.
  $bandTop = $offY + [int](2 * $scale)
  $bandBottom = $offY + [int](38 * $scale)
  $bandRight = $offX + [int](260 * $scale)
  $stride = $chrome.Stride
  $bytes = $chrome.Bytes
  function LumAt($x, $y) {
    $p = $y * $stride + $x * 4
    return [int]((299 * $bytes[$p + 2] + 587 * $bytes[$p + 1] + 114 * $bytes[$p]) / 1000)
  }
  $inkCols = @{}
  for ($x = $offX; $x -lt [Math]::Min($bandRight, $chrome.Width - 1); $x++) {
    $min = 255; $max = 0
    for ($y = $bandTop; $y -lt [Math]::Min($bandBottom, $chrome.Height - 1); $y++) {
      $l = LumAt $x $y
      if ($l -lt $min) { $min = $l }
      if ($l -gt $max) { $max = $l }
    }
    if (($max - $min) -gt 24) { $inkCols[$x - $offX] = $true }
  }

  # Groups of inked columns, merging gaps up to 4 CSS px: that keeps the letters
  # of one word together while leaving the three command cells apart, since their
  # glyphs sit 18 px apart with air between them.
  $mergeGap = [int](4 * $scale)
  $groups = New-Object 'System.Collections.Generic.List[object]'
  $start = -1
  $last = -1
  foreach ($x in ($inkCols.Keys | Sort-Object)) {
    if ($start -lt 0) { $start = $x; $last = $x; continue }
    if (($x - $last) -le $mergeGap) { $last = $x; continue }
    $groups.Add([pscustomobject]@{ Start = $start; End = $last })
    $start = $x
    $last = $x
  }
  if ($start -ge 0) { $groups.Add([pscustomobject]@{ Start = $start; End = $last }) }

  $controlsLimit = 70 * $scale
  $controls = @($groups | Where-Object { $_.End -lt $controlsLimit })
  $word = @($groups | Where-Object { $_.Start -ge (60 * $scale) }) | Select-Object -First 1

  # Save the strip, cropped from the capture, as the evidence for this reading.
  $stripW = [Math]::Min([int](260 * $scale), $chrome.Width - $offX)
  $stripH = [Math]::Min([int](40 * $scale), $chrome.Height - $offY)
  $strip = New-Object System.Drawing.Bitmap $stripW, $stripH
  $sg = [System.Drawing.Graphics]::FromImage($strip)
  $srcRect = New-Object System.Drawing.Rectangle $offX, $offY, $stripW, $stripH
  $dstRect = New-Object System.Drawing.Rectangle 0, 0, $stripW, $stripH
  $sg.DrawImage($chrome.Bitmap, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $sg.Dispose()
  $strip.Save((Join-Path $Out "02-chrome-strip-$Label.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $strip.Dispose()

  if ($null -eq $word) {
    Release $chrome
    Verdict $false "b" "no wordmark found right of the command cells (groups: $($groups.Count))"
  }

  $wordStartCss = [Math]::Round($word.Start / $scale, 1)

  # Vertical centres, so the word and the commands can be said to sit on the same
  # line instead of merely being present.
  function BandCentre($fromX, $toX) {
    $first = -1; $lastRow = -1
    for ($y = $bandTop; $y -lt [Math]::Min($bandBottom, $chrome.Height - 1); $y++) {
      $min = 255; $max = 0
      for ($x = $offX + $fromX; $x -lt [Math]::Min($offX + $toX, $chrome.Width - 1); $x++) {
        $l = LumAt $x $y
        if ($l -lt $min) { $min = $l }
        if ($l -gt $max) { $max = $l }
      }
      if (($max - $min) -gt 24) {
        if ($first -lt 0) { $first = $y }
        $lastRow = $y
      }
    }
    if ($first -lt 0) { return $null }
    return ($first + $lastRow) / 2.0
  }
  $cFrom = ($controls | Select-Object -First 1)
  $cTo = ($controls | Select-Object -Last 1)
  $controlsCentre = if ($cFrom) { BandCentre $cFrom.Start $cTo.End } else { $null }
  $wordCentre = BandCentre $word.Start $word.End
  $deltaCss = if ($null -ne $controlsCentre -and $null -ne $wordCentre) { [Math]::Round([Math]::Abs($wordCentre - $controlsCentre) / $scale, 1) } else { $null }
  Release $chrome

  # WHERE THE FIRST PIXEL OF THE WORD BELONGS, derived from the constants and not
  # from what the screen happened to show:
  #   6   ROW_INSET, where the title wrapper starts in the client area
  #  66   TITLE_INSET_WINDOWS_PX, the room the wrapper reserves for the commands
  #   8   ROW_PX (`px-2`) on the label itself, which is a padding INSIDE the inset
  # The first two are what the card asks about; the third is the reason the ink
  # starts at 80 and not at 72, and it took a measurement to notice. The command
  # cells are checked against their own declared box instead: they start at 12
  # (`left-[6px]` in a wrapper at ROW_INSET) and the three of them end at 66.
  $expectedCss = 6 + 66 + 8
  $controlsFrom = if ($cFrom) { [Math]::Round($cFrom.Start / $scale, 1) } else { -1 }
  $controlsTo = if ($cTo) { [Math]::Round($cTo.End / $scale, 1) } else { -1 }
  $okStart = [Math]::Abs($wordStartCss - $expectedCss) -le 4
  $okCount = $controls.Count -eq 3
  $okBox = ($controlsFrom -ge 12) -and ($controlsTo -le 66)
  $okAlign = ($null -ne $deltaCss) -and ($deltaCss -le 4)
  Verdict ($okStart -and $okCount -and $okBox -and $okAlign) "b" "chrome: $($controls.Count) command cells (want 3) inside $controlsFrom..$controlsTo CSS px (want 12..66), wordmark ink at $wordStartCss CSS px (want $expectedCss +/-4), baseline offset $deltaCss CSS px (want <=4)"
}

if ((Wants 'c') -or (Wants 'e')) {
  # Three closes, unconditionally, and no early exit on a small reading: closing a
  # pane can move as little as 0.6% of the samples (measured), so "nothing
  # changed" is not evidence that there was nothing left to close. Getting this
  # wrong is what made the check fail for the wrong reason: with a browser pane
  # still open the palette hides the entry, the mnemonic lands on nothing, and the
  # run reads 0% and blames the shell.
  $closes = @()
  for ($try = 1; $try -le 3; $try++) {
    $paneBefore = Grab $h $null
    Send "^w"
    $paneAfter = Grab $h $null
    $closes += Pct (DiffRatio $paneBefore $paneAfter)
    Release $paneBefore
    Release $paneAfter
  }
  Say "-- Ctrl+W x3 to clear restored panes: $($closes -join ', ')"
}

# ------------------------------------------------------------------- (c) ----
# A shortcut is judged by what it CHANGES on screen and by the change going away
# again: an overlay that appears and stays is not the same feature.
if (Wants 'c') {

  if (-not (Focus $h)) { Verdict $false "c" "the window refused to come to the foreground: no keyboard reading here would be about it" }
  $before = Grab $h $null
  $searchKey = if ($WrongKey) { "^{F13}" } else { "^k" }
  if ($WrongKey) { Say "arm: sending an unbound combination instead of Ctrl+K" }
  Send $searchKey
  $opened = Grab $h (Join-Path $Out "03-shortcut-search-$Label.png")
  $dOpen = DiffRatio $before $opened
  Release $opened
  $back = Dismiss $h $before $null
  Verdict ((($null -ne $dOpen) -and $dOpen -gt 0.03) -and (($null -ne $back.Diff) -and $back.Diff -lt 0.015)) "c1" "Ctrl+K: opened $(Pct $dOpen) (want >3%), closed back to $(Pct $back.Diff) after $($back.Escapes) Escape (want <1.5%)"

  Send "^n"
  $menu = Grab $h (Join-Path $Out "06-add-menu-$Label.png")
  $dMenu = DiffRatio $before $menu
  Release $menu
  $menuBack = Dismiss $h $before (Join-Path $Out "10-after-escape-$Label.png")
  Verdict ((($null -ne $dMenu) -and $dMenu -gt 0.03) -and (($null -ne $menuBack.Diff) -and $menuBack.Diff -lt 0.015)) "c2" "Ctrl+N: menu $(Pct $dMenu) (want >3%), dismissed to $(Pct $menuBack.Diff) after $($menuBack.Escapes) Escape (want <1.5%)"
}

# ------------------------------------------------------------------- (e) ----
# Ctrl+N then the bare letter B is the frozen mnemonic for a new Browser pane
# (`client/src/state/pane/adapters/paneMnemonics.ts`). Both URLs are local: a
# reading that needs the internet measures the network, not the pane.
if (Wants 'e') {

  # A browser pane is a SINGLETON in this scope: with one already open, the menu
  # hides the entry and the mnemonic types a letter into nothing. So the check
  # starts by closing whatever panes the app restored from the last session, and
  # says how many it had to close: a run that measured "nothing happened" because
  # the thing was already there is the failure mode this avoids.
  $before = Grab $h $null

  Send "^n"
  Send "b"
  Start-Sleep 6
  $paneOpen = Grab $h (Join-Path $Out "07-pane-open-$Label.png")
  $dPane = DiffRatio $before $paneOpen
  if ($null -eq $dPane -or $dPane -le 0.05) {
    Release $paneOpen
    Verdict $false "e" "browser pane did not open: $(Pct $dPane) of the window changed (want >5%)"
  }
  # DOES ANY KEY STILL REACH THE CLIENT ONCE THE PANE IS UP? On Windows the pane
  # is a native WebView2 child window, and when it holds the keyboard focus the
  # client's `window` keydown listeners never fire: every shortcut below would
  # then read zero for a reason that has nothing to do with the shortcut. So the
  # probe first re-asks Ctrl+K, which was PROVED to work minutes earlier in (c)
  # on this same window. Its answer is what tells a dead shortcut apart from a
  # probe typing into a child window nobody wired.
  Focus $h | Out-Null
  Send "^k"
  $paneKeys = Grab $h $null
  $dPaneKeys = DiffRatio $paneOpen $paneKeys
  Release $paneKeys
  Say "-- Ctrl+K with the pane focused: $(Pct $dPaneKeys) (it read >3% in (c) on the bare window)"
  Send "{ESC}"
  Start-Sleep -Milliseconds 600

  # Ctrl+L focuses the URL bar (`RemoteBrowserPanel`), so the typing lands there
  # whatever had focus when the pane opened. The first URL is a path the server
  # does not serve, which paints an error page; the second is the app itself. Both
  # on the loopback: a reading that needs the internet measures the network.
  [System.Windows.Forms.SendKeys]::SendWait("^l")
  Start-Sleep -Milliseconds 400
  [System.Windows.Forms.SendKeys]::SendWait("http://127.0.0.1:13333/robots.txt{ENTER}")
  Start-Sleep 5
  $firstUrl = Grab $h $null
  $inkFirst = InkPercent $firstUrl
  [System.Windows.Forms.SendKeys]::SendWait("^l")
  Start-Sleep -Milliseconds 400
  [System.Windows.Forms.SendKeys]::SendWait("http://127.0.0.1:13333/{ENTER}")
  Start-Sleep 8
  $secondUrl = Grab $h (Join-Path $Out "05-browser-pane-$Label.png")
  $inkSecond = InkPercent $secondUrl
  $dNav = DiffRatio $firstUrl $secondUrl
  Release $firstUrl
  Release $secondUrl
  Release $paneOpen
  Verdict ((($null -ne $dNav) -and $dNav -gt 0.05) -and ($inkSecond -ge 30)) "e" "browser pane: opened $(Pct $dPane), navigation changed $(Pct $dNav) (want >5%), page ink $inkSecond% after the second URL (want >=30%), first URL ink $inkFirst%, Ctrl+K with the pane focused $(Pct $dPaneKeys)"

  Send "^w"
  Start-Sleep 1
  $afterClose = Grab $h $null
  $dClose = DiffRatio $before $afterClose
  Release $afterClose
  Verdict (($null -ne $dClose) -and $dClose -lt 0.05) "c3" "Ctrl+W: pane closed, window back to $(Pct $dClose) of the layout it had (want <5%)"
}

# ------------------------------------------------------------------- (d) ----
if (Wants 'd') {
  $cycles = 3
  $restoreFails = 0
  $restoreLines = @()
  for ($i = 1; $i -le $cycles; $i++) {
    Focus $h | Out-Null
    $a = Grab $h $null
    [DesktopCheck]::ShowWindow($h, 6) | Out-Null   # SW_MINIMIZE
    Start-Sleep -Milliseconds 2500
    [DesktopCheck]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
    [DesktopCheck]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds $SettleMs
    $png = if ($i -eq 1) { Join-Path $Out "04-restore-after-$Label.png" } else { $null }
    $b = Grab $h $png
    $inkB = InkPercent $b
    $dRestore = DiffRatio $a $b
    Release $a
    Release $b
    $ok = ($inkB -ge 10) -and ($null -ne $dRestore) -and ($dRestore -le 0.30)
    if (-not $ok) { $restoreFails++ }
    $restoreLines += "cycle ${i}: ink $inkB% diff $(Pct $dRestore)"
  }
  Verdict ($restoreFails -eq 0) "d" "restore: $($cycles - $restoreFails)/$cycles repainted [$($restoreLines -join '; ')]"
}

$repaint = Join-Path $env:LOCALAPPDATA "io.armonia.topics.tauri\repaint.log"
if (Test-Path $repaint) {
  Say "-- repaint.log, last 6 lines"
  Get-Content $repaint -Tail 6 | ForEach-Object { Say "   $_" }
}

Say "== all checks passed on $installed"
Cleanup
exit 0
