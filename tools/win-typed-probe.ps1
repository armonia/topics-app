# CAN A PERSON OPEN THE BROWSER PANE AND TYPE AN ADDRESS INTO IT?
#
# `win-browser-probe.ps1` opens the pane with the client mnemonic (Ctrl+N then
# b). When the client swallows its own shortcuts (card cd040754) that path never
# gets a pane, and the pane's keyboard is left unmeasured behind a defect that is
# not about the pane. This probe removes that dependency: it opens the pane with
# the MOUSE and then types the address with the keyboard, which is the scenario
# the product promises.
#
# It restarts the app so the pane is created by this run and not restored from a
# previous one, reuses the TCP witness of `win-browser-probe.ps1` (a port the app
# does not use, every request logged with its User-Agent: `Edg/` is the pane's
# native WebView2), and captures the window at each step.
#
# Run it ON the Windows machine inside a scheduled task registered with `/it`,
# like the gate: from an ssh session the console user's windows do not exist.
# The driver next to this file (`win-typed-probe.sh`) does that.
#
#   powershell -File win-typed-probe.ps1 -Out C:\...\out -Label fresh
#
# The menu fractions are where the two clicks land: the "New" command in the top
# strip, and the "Browser" entry of the menu it opens, both measured on the
# window this app draws at 1416x939.
param(
  [string]$Out = 'C:\Users\zorah\topics-win-check',
  [string]$Label = 'fresh',
  # Not 13333: that is the app's own server, and a request logged there would
  # prove nothing about who made it.
  [int]$Port = 13444,
  [string]$Exe = 'C:\Users\zorah\AppData\Local\Topics\app.exe',
  # The "New" command in the top strip, as a fraction of the window.
  [double]$NewX = 0.252,
  [double]$NewY = 0.0215,
  # The "Browser" entry of the menu it opens.
  [double]$EntryX = 0.5,
  [double]$EntryY = 0.207
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class F {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetGUIThreadInfo(IntPtr t, ref G g);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public struct R { public int L,T,Rr,B; }
  public struct G { public int cbSize; public int flags; public IntPtr hwndActive,hwndFocus,hwndCapture,hwndMenuOwner,hwndMoveSize,hwndCaret; public R rcCaret; }
}
"@
$log=Join-Path $Out "typed-$Label.log"; $witnessLog=Join-Path $Out "witness-$Label.log"; $stopFile=Join-Path $Out "witness-$Label.stop"
function Say($m){ $m | Add-Content $log }
Set-Content $log "== fresh-pane typed probe, label $Label, port $Port"
Remove-Item $stopFile,$witnessLog -ErrorAction SilentlyContinue
Start-Process powershell -WindowStyle Hidden -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File","$Out\win-browser-probe.ps1","-Witness","-Port",$Port,"-Out",$Out,"-Label",$Label) | Out-Null
Start-Sleep 3
try { (New-Object Net.WebClient).DownloadString("http://127.0.0.1:$Port/probe-selftest") | Out-Null } catch {}
function Focused(){ $g=New-Object F+G; $g.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($g); [F]::GetGUIThreadInfo([IntPtr]::Zero,[ref]$g)|Out-Null
  if($g.hwndFocus -eq [IntPtr]::Zero){return "NO window"}; $sb=New-Object Text.StringBuilder 256; [F]::GetClassName($g.hwndFocus,$sb,256)|Out-Null
  $q=0;[F]::GetWindowThreadProcessId($g.hwndFocus,[ref]$q)|Out-Null; $n=try{(Get-Process -Id $q).ProcessName}catch{"?"}; return "$($sb.ToString()) pid=$q $n" }
function Hits(){ if(Test-Path $witnessLog){@(Get-Content $witnessLog|Where-Object{$_ -match 'UA=' -and $_ -notmatch 'probe-selftest'})}else{@()} }
function Win(){ (Get-Process app -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle }
function Shot($n){ $rc=New-Object F+R;[F]::GetWindowRect($h,[ref]$rc)|Out-Null; $b=New-Object Drawing.Bitmap ($rc.Rr-$rc.L),($rc.B-$rc.T); $g2=[Drawing.Graphics]::FromImage($b); $g2.CopyFromScreen($rc.L,$rc.T,0,0,$b.Size); $b.Save((Join-Path $Out "$n-$Label.png"),[Drawing.Imaging.ImageFormat]::Png); $g2.Dispose(); $b.Dispose() }
function Click($fx,$fy){ $rc=New-Object F+R;[F]::GetWindowRect($h,[ref]$rc)|Out-Null; $x=[int]($rc.L+($rc.Rr-$rc.L)*$fx); $y=[int]($rc.T+($rc.B-$rc.T)*$fy)
  [F]::SetCursorPos($x,$y)|Out-Null; Start-Sleep -Milliseconds 250; [F]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero); [F]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero); Say "   click $x,$y"; Start-Sleep -Milliseconds 900 }

# Restart the app so the pane is created from scratch by this run.
Get-Process app -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 4
Start-Process $Exe
Start-Sleep 25
$h = Win
if (-not $h) { Say "FAIL no window after relaunch"; New-Item -ItemType File -Force -Path $stopFile|Out-Null; exit 2 }
[F]::ShowWindow($h,9)|Out-Null; [F]::SetForegroundWindow($h)|Out-Null; Start-Sleep 2
Say "-- after relaunch, focus: $(Focused)"
Shot "40-after-relaunch"
# Open a browser pane WITH THE MOUSE (the client keyboard is the other card's subject).
Click $NewX $NewY
Start-Sleep 2
Shot "41-menu"
Click $EntryX $EntryY
Start-Sleep 6
Say "-- pane opened, focus: $(Focused)"
Shot "42-pane-open"
# THE MEASURE: type the address at once, no click, no Ctrl+L.
[Windows.Forms.SendKeys]::SendWait("http://127.0.0.1:$Port/fresh-pane{ENTER}")
Start-Sleep 9
Say "-- typing straight after the pane opened: $(@(Hits).Count) request(s); focus: $(Focused)"
Shot "43-after-typing"
Say "== witness log =="
foreach($l in (Get-Content $witnessLog -ErrorAction SilentlyContinue)){ Say "   $l" }
New-Item -ItemType File -Force -Path $stopFile|Out-Null
Say "== done"
exit 0
