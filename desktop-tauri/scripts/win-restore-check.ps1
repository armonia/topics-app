# DOES THE WINDOW COME BACK PAINTED? The gate that answers it, N times in a row.
#
# Run it ON the Windows machine, inside a scheduled task with `LogonType
# Interactive`: from an ssh session the console user's windows do not exist, so
# enumeration, handles, PrintWindow and Start-Process all lie. The driver next to
# this file (`win-restore-check.sh`) registers and runs that task for you.
#
#   powershell -File win-restore-check.ps1 -Runs 10 -Out C:\...\out -Label on
#
# ONE CYCLE: capture A (window as it is), minimise, restore, wait, capture B,
# wait some more, capture C. Then compare, and exit non-zero if any cycle failed.
#
# WHAT IT COMPARES, and why not an absolute reading. An absolute threshold cannot
# tell "does not paint" from "has nothing to show", so the window is compared
# with ITSELF across the transition: same window, same scene, seconds apart. Two
# numbers per cycle, and a cycle has to pass both:
#
#   ink   rows of B that carry a luminance step above 24 between neighbouring
#         samples. This is the discriminator that works: a flat grey wash is as
#         neutral as the interface and so is a blurred wallpaper behind the
#         Acrylic backdrop, so counting neutral pixels answered "painted" for a
#         window a screenshot shows as empty. Edges are what a drawn interface
#         has and a wash does not. Healthy 77/77, broken 1/77.
#   diff  fraction of sampled pixels whose luminance moved by more than 24
#         between A and B. It answers the other half of the question: B is not
#         merely inked, it is the SAME SCENE that was there before.
#
# WHY THE DIFF CEILING IS LOOSE (30% by default). The remedy in
# `src/windows_repaint.rs` cures the restore by rebuilding the webview, which
# reloads the page: B is the same app on the same route, not the same pixels. A
# tight ceiling would fail the cure it is supposed to certify. What it still
# catches is the failure this measures: a window that comes back grey differs
# from A almost everywhere.
#
# C IS THE "IT DOES NOT RECOVER ON ITS OWN" READING, captured at +5s and only
# reported. The defect never healed by itself in any measurement (right after,
# +3s and +11s were all 1/77), so C is evidence, not a second chance: the verdict
# stays on B.
#
# EXIT CODE: 0 only if every cycle passed. That is what makes this a gate.
param(
  [int]$Runs = 10,
  [string]$Out = "$env:TEMP\topics-restore-check",
  [string]$Label = "run",
  [string]$ProcName = "app",
  # Kill and relaunch the app before measuring. Needed to choose the arm, since
  # the remedy is read from the environment at startup.
  [switch]$Restart,
  # Launch it with `TOPICS_NO_WEBVIEW_REBUILD` set, which turns the remedy off.
  # This is the falsification arm: it must FAIL.
  [switch]$NoRemedy,
  # Time from the restore to capture B. The remedy takes about 850ms end to end
  # (measured), plus the page load it costs.
  [int]$SettleMs = 4000,
  [int]$MinimizedMs = 2500
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Runtime.InteropServices;
public class RestoreCheck {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$logPath = Join-Path $Out "restore-check-$Label.log"
$lines = @()
function Say($text) {
  $script:lines += $text
  Write-Output $text
}

# Largest visible top-level window owned by the app process.
function Find-AppWindow($procName) {
  $script:found = [IntPtr]::Zero
  $script:best = 0
  $cb = [RestoreCheck+EnumProc]{ param($h, $l)
    $owner = 0
    [RestoreCheck]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
    $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq $procName -and [RestoreCheck]::IsWindowVisible($h)) {
      $r = New-Object RestoreCheck+RECT
      [RestoreCheck]::GetWindowRect($h, [ref]$r) | Out-Null
      $area = ($r.R - $r.L) * ($r.B - $r.T)
      if ($area -gt $script:best) { $script:best = $area; $script:found = $h }
    }
    return $true
  }
  [RestoreCheck]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:found
}

# The window's OWN buffer, via PrintWindow with PW_RENDERFULLCONTENT: it reads
# what the window drew even when something covers it, which CopyFromScreen
# cannot. Returns a luminance grid, not a bitmap, so every later reading is done
# on the same samples.
function Grab($h, $pngPath) {
  $r = New-Object RestoreCheck+RECT
  [RestoreCheck]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.R - $r.L
  $ht = $r.B - $r.T
  if ($w -lt 200 -or $ht -lt 200) { return $null }
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  $drew = [RestoreCheck]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc)
  if (-not $drew) { $g.Dispose(); $bmp.Dispose(); return $null }
  if ($pngPath) { $bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png) }

  # One LockBits pass into a byte array: GetPixel per sample is minutes, this is
  # milliseconds, and the sampling grid below is the same either way.
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $ht
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $bytes = New-Object byte[] ($stride * $ht)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($data)
  $g.Dispose()
  $bmp.Dispose()

  # Rows every 12px, columns every 3px: the answer is 77-vs-1, not a close call,
  # so a coarse grid is enough and keeps a cycle under a second.
  $grid = New-Object 'System.Collections.Generic.List[int[]]'
  for ($y = 8; $y -lt $ht - 8; $y += 12) {
    $row = New-Object 'System.Collections.Generic.List[int]'
    $base = $y * $stride
    for ($x = 12; $x -lt $w - 12; $x += 3) {
      $p = $base + $x * 4
      # BGRA in memory.
      $lum = [int]((299 * $bytes[$p + 2] + 587 * $bytes[$p + 1] + 114 * $bytes[$p]) / 1000)
      $row.Add($lum)
    }
    $grid.Add($row.ToArray())
  }
  return [pscustomobject]@{ Grid = $grid; Width = $w; Height = $ht }
}

# Rows carrying a luminance step above 24 between neighbouring samples.
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

# Fraction of samples that moved by more than 24 between the two captures.
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

if ($Restart) {
  Get-Process $ProcName -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep 3
  $exe = Join-Path $env:LOCALAPPDATA "Topics\$ProcName.exe"
  if (-not (Test-Path $exe)) { Say "NO EXE at $exe"; $lines -join "`n" | Set-Content $logPath; exit 2 }
  if ($NoRemedy) {
    $env:TOPICS_NO_WEBVIEW_REBUILD = "1"
    Say "arm: remedy OFF (TOPICS_NO_WEBVIEW_REBUILD=1)"
  } else {
    Remove-Item Env:\TOPICS_NO_WEBVIEW_REBUILD -ErrorAction SilentlyContinue
    Say "arm: remedy ON"
  }
  Start-Process $exe | Out-Null
}

# Wait for a window that is not only there but already drawing: a capture taken
# while the app is still booting would make A itself blank and every later
# comparison meaningless.
$h = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  $h = Find-AppWindow $ProcName
  if ($h -ne [IntPtr]::Zero) {
    [RestoreCheck]::ShowWindow($h, 9) | Out-Null
    [RestoreCheck]::SetForegroundWindow($h) | Out-Null
    $warm = Ink (Grab $h $null)
    if ($warm -and $warm.Rows -gt 0 -and ($warm.Inked * 4) -gt $warm.Rows) { break }
  }
  Start-Sleep 2
}
if ($h -eq [IntPtr]::Zero) { Say "NO WINDOW for process '$ProcName'"; $lines -join "`n" | Set-Content $logPath; exit 2 }
Say "window 0x$($h.ToString('x')) $Label runs=$Runs settle=${SettleMs}ms"

$failed = 0
for ($i = 1; $i -le $Runs; $i++) {
  [RestoreCheck]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 600
  $a = Grab $h (Join-Path $Out "$Label-$i-A.png")
  $inkA = Ink $a

  [RestoreCheck]::ShowWindow($h, 6) | Out-Null   # SW_MINIMIZE
  Start-Sleep -Milliseconds $MinimizedMs
  [RestoreCheck]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
  [RestoreCheck]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds $SettleMs

  $b = Grab $h (Join-Path $Out "$Label-$i-B.png")
  $inkB = Ink $b
  $diff = DiffRatio $a $b
  Start-Sleep 5
  $c = Grab $h (Join-Path $Out "$Label-$i-C.png")
  $inkC = Ink $c

  # A blind probe is not a pass: a reading that could not be taken must not be
  # the reason a broken window is called healthy.
  $okInk = $inkB -and $inkB.Rows -gt 0 -and ($inkB.Inked * 10) -ge $inkB.Rows
  $okDiff = ($null -ne $diff) -and ($diff -le 0.30)
  $ok = $okInk -and $okDiff
  $verdict = if ($ok) { "PASS" } else { "FAIL" }
  if (-not $ok) { $failed++ }

  $aTxt = if ($inkA) { "$($inkA.Inked)/$($inkA.Rows)" } else { "blind" }
  $bTxt = if ($inkB) { "$($inkB.Inked)/$($inkB.Rows)" } else { "blind" }
  $cTxt = if ($inkC) { "$($inkC.Inked)/$($inkC.Rows)" } else { "blind" }
  $dTxt = if ($null -ne $diff) { "$([Math]::Round($diff * 100, 1))%" } else { "n/a" }
  Say "$verdict cycle $i : ink A $aTxt -> B $bTxt (+5s $cTxt), diff A/B $dTxt"
}

# The shell writes one line per transition in its app data directory (which is
# named after the bundle identifier, NOT after the install folder): it says
# whether the remedy ran at all, which is the difference between "it never fired"
# and "it fired and did not help".
$repaint = Join-Path $env:LOCALAPPDATA "io.armonia.topics.tauri\repaint.log"
if (-not (Test-Path $repaint)) {
  $found = Get-ChildItem $env:LOCALAPPDATA -Filter repaint.log -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $repaint = $found.FullName }
}
if (Test-Path $repaint) {
  Say "-- repaint.log, last 12 lines"
  Get-Content $repaint -Tail 12 | ForEach-Object { Say "   $_" }
}

Say "$($Runs - $failed)/$Runs cycles repainted"
$lines -join "`n" | Set-Content $logPath
if ($failed -gt 0) { exit 1 }
exit 0
