# The PC must become reachable again by itself after a reboot, with nobody at it.
# Why: a reboot once left it stuck at the logon screen, with no sshd and no
# Tailscale: several cards blocked and a physical gesture asked of the user.
#
# -Fix    repairs what can be repaired from here (needs an elevated PowerShell,
#         which the one from ssh already is): sshd and Tailscale automatic and
#         started, Tailscale unattended (stays connected with nobody logged on).
# without only checks: prints OK/KO per item, exit 1 if one does not survive a boot.
# Automatic logon is not needed: node and jail start at boot as S4U.
param([switch]$Fix)
$ko = @()
function Check($name, $ok, $why) { if ($ok) { "OK  $name" } else { "KO  ${name}: $why"; $script:ko += $name } }

foreach ($svc in 'sshd', 'Tailscale') {
  $s = Get-Service $svc -ErrorAction SilentlyContinue
  if (-not $s) { Check $svc $false 'service missing'; continue }
  if ($Fix) {
    Set-Service $svc -StartupType Automatic
    # the delayed one starts ~2 minutes after boot and can lose the race with whoever looks for it
    sc.exe config $svc start= auto | Out-Null
    if ($s.Status -ne 'Running') { Start-Service $svc }
    sc.exe failure $svc reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
  }
  $s = Get-CimInstance Win32_Service -Filter "Name='$svc'"
  Check "$svc automatic start" ($s.StartMode -eq 'Auto' -and -not $s.DelayedAutoStart) "StartMode=$($s.StartMode) delayed=$($s.DelayedAutoStart)"
  Check "$svc running" ($s.State -eq 'Running') $s.State
}

$ts = "$env:ProgramFiles\Tailscale\tailscale.exe"
if (Test-Path $ts) {
  if ($Fix) { & $ts set --unattended=true 2>&1 | Out-Null }
  $prefs = & $ts debug prefs 2>$null | Out-String
  Check 'Tailscale unattended' ($prefs -match '"ForceDaemon":\s*true') 'without unattended it disconnects when nobody is logged on'
}

# firewall: port 22 open on the Public network too (after a reboot the network can change profile)
$fw = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if ($Fix -and $fw) { Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Profile Any -Enabled True }
$fw = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
Check 'firewall 22 on every profile' ($fw -and $fw.Enabled -eq 'True' -and "$($fw.Profile)" -eq 'Any') "rule $(if ($fw) { "$($fw.Profile)/$($fw.Enabled)" } else { 'missing' })"

# node at boot with no logon: topics-node and topics-card-jail run as S4U at startup, so
# automatic logon (and the user's password) is not needed.
foreach ($t in 'topics-node', 'topics-card-jail') {
  $st = Get-ScheduledTask $t -ErrorAction SilentlyContinue
  $boot = $st -and ($st.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' })
  Check "node starts at boot with no logon ($t)" ($boot -and $st.Principal.LogonType -eq 'S4U') "trigger/LogonType: $(if ($st) { "$($st.Triggers.CimClass.CimClassName) $($st.Principal.LogonType)" } else { 'task missing' }) (register-node.ps1 / register-card-jail.ps1)"
}
if ($ko.Count) { exit 1 }
