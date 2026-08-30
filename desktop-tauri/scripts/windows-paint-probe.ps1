# DOES THE WINDOW STILL PAINT AFTER A RESTORE? The probe that answers it.
#
# Run it ON the Windows machine, as a scheduled task with `LogonType Interactive`
# (from ssh the user's windows do not exist - enumeration, handles and
# Start-Process all lie). It brings the app window forward, captures it with
# PrintWindow (so z-order cannot fake the answer the way CopyFromScreen can),
# minimises it, restores it, and captures again right after, at +3s and at +11s.
#
#   powershell -File windows-paint-probe.ps1 app
#
# WHAT IT COUNTS, and why not the obvious thing. The first version of this probe
# asked "is any sampled pixel of this row near-neutral" and answered 79/79 for a
# window that a screenshot shows as EMPTY: a flat grey wash is exactly as neutral
# as the interface, and so is a blurred wallpaper behind an Acrylic backdrop. It
# measured nothing and it read like a verdict, and a real remedy was turned off
# on the strength of it.
#
# What a drawn interface has and a wash does not is EDGES. A row counts when two
# neighbouring samples differ in luminance by more than 24. Measured with it,
# minimise + restore, twice per arm:
#
#           before    right after   +3s     +11s
#   OFF      77/77       1/77       1/77    1/77
#   ON       77/77      77/77      77/77   77/77
#
# (OFF = `TOPICS_NO_WEBVIEW_REBUILD` set; see src/windows_repaint.rs.)
param([string]$ProcName = "app")
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;using System.Runtime.InteropServices;
public class PaintProbe {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
$outDir = Join-Path $env:TEMP "topics-paint-probe"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Find-AppWindow($procName) {
  $script:found = [IntPtr]::Zero; $script:best = 0
  $cb = [PaintProbe+EnumProc]{ param($h, $l)
    $owner = 0; [PaintProbe]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
    $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq $procName -and [PaintProbe]::IsWindowVisible($h)) {
      $r = New-Object PaintProbe+RECT; [PaintProbe]::GetWindowRect($h, [ref]$r) | Out-Null
      $area = ($r.R - $r.L) * ($r.B - $r.T)
      if ($area -gt $script:best) { $script:best = $area; $script:found = $h }
    }
    return $true
  }
  [PaintProbe]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  return $script:found
}

function Measure-Paint($h, $name) {
  $r = New-Object PaintProbe+RECT; [PaintProbe]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.R - $r.L; $ht = $r.B - $r.T
  if ($w -le 0 -or $ht -le 0) { return "$name : minimised" }
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc(); [PaintProbe]::PrintWindow($h, $dc, 2) | Out-Null; $g.ReleaseHdc($dc)
  $bmp.Save((Join-Path $outDir "paint-$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $withEdges = 0; $rows = 0
  for ($y = 8; $y -lt $ht - 8; $y += 12) {
    $rows++
    $prev = -1; $hit = $false
    for ($x = 12; $x -lt $w - 12; $x += 3) {
      $c = $bmp.GetPixel($x, $y)
      $lum = [int](0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)
      if ($prev -ge 0 -and [Math]::Abs($lum - $prev) -gt 24) { $hit = $true; break }
      $prev = $lum
    }
    if ($hit) { $withEdges++ }
  }
  $g.Dispose(); $bmp.Dispose()
  return "$name : rows with drawing $withEdges/$rows"
}

$h = Find-AppWindow $ProcName
if ($h -eq [IntPtr]::Zero) { "NO WINDOW for process '$ProcName'"; exit 1 }
$out = @()
[PaintProbe]::SetForegroundWindow($h) | Out-Null; Start-Sleep 2
$out += Measure-Paint $h "0-before"
[PaintProbe]::SendMessage($h, 0x0112, [IntPtr]0xF020, [IntPtr]0) | Out-Null   # SC_MINIMIZE
Start-Sleep 3
[PaintProbe]::SendMessage($h, 0x0112, [IntPtr]0xF120, [IntPtr]0) | Out-Null   # SC_RESTORE
[PaintProbe]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
$out += Measure-Paint $h "1-right-after"
Start-Sleep 3
$out += Measure-Paint $h "2-plus3s"
Start-Sleep 8
$out += Measure-Paint $h "3-plus11s"
$out += "captures in $outDir"
$out -join "`n" | Tee-Object -FilePath (Join-Path $outDir "paint.txt")
