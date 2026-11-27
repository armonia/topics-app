# Card jail of the node: every claude/codex CLI launched by Topics ends up
# in a Windows Job Object. When the card's CLI exits, TerminateJobObject
# kills every grandchild left behind (find, bash, node).
# No KILL_ON_JOB_CLOSE on purpose: with it, the death of the jail itself
# (reboot, update) would kill live cards. If the jail dies, the jobs are left
# without an owner: the orphan reaper of node-prep covers them.
# Why: a `find / -type d` launched by a card once outlived the card by 4 hours,
# 15,784 s of CPU and 9.66 million handles; the kernel paged pool reached 30 GB.
# Caps for every process in the jail: 1 hour of CPU (job limit) and
# 200 thousand handles (enforced by us: jobs have no handle limit).
#
# Usage: card-jail.ps1            resident (scheduled task "topics-card-jail")
#        card-jail.ps1 -Test      red/green: without the jail the grandchild stays, with the jail it dies
#        card-jail.ps1 -Test -NoJail   the red branch only
param([switch]$Test, [switch]$NoJail,
      [string]$Log = $(Join-Path $(if ($env:TOPICS_NODE_DIR) { $env:TOPICS_NODE_DIR } else { "C:\topics-node" }) "logs\card-jail.log"),
      [int]$MaxHandles = 200000, [int]$CpuSeconds = 3600)
$ErrorActionPreference = "Continue"
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class Jail {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinWS, MaxWS; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, int l);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr j, uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  // Kills everything left in the card's job and closes the job
  public static bool Kill(IntPtr j) { bool ok = TerminateJobObject(j, 1); CloseHandle(j); return ok; }
  // 0x2 PROCESS_TIME
  public static IntPtr Wrap(int pid, long cpuSeconds, string name) {
    IntPtr j = CreateJobObject(IntPtr.Zero, name);
    if (j == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
    EXT e = new EXT(); e.Basic.LimitFlags = 0x2; e.Basic.PerProcessUserTimeLimit = cpuSeconds * 10000000L;
    if (!SetInformationJobObject(j, 9, ref e, Marshal.SizeOf(typeof(EXT)))) { CloseHandle(j); throw new Exception("SetInformationJobObject " + Marshal.GetLastWin32Error()); }
    IntPtr p = OpenProcess(0x0101, false, pid); // SET_QUOTA | TERMINATE
    if (p == IntPtr.Zero) { CloseHandle(j); throw new Exception("OpenProcess " + Marshal.GetLastWin32Error()); }
    bool ok = AssignProcessToJobObject(j, p); int err = Marshal.GetLastWin32Error(); CloseHandle(p);
    if (!ok) { CloseHandle(j); throw new Exception("AssignProcessToJobObject " + err); }
    return j;
  }
}
"@
function Say($t) { $l = "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $t"; if ($Test) { Write-Output $l } else { $l | Add-Content $Log } }

# descendants of a pid (for the handle cap)
function Descendants($rootPid, $all) {
  $out = @(); $q = @($rootPid)
  while ($q.Count) { $x = $q[0]; $q = @($q | Select-Object -Skip 1); foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $x }) { $out += $c; $q += $c.ProcessId } }
  $out
}

if ($Test) {
  # fake card: the root is born, gets jailed, launches a sleeping child and then exits
  $marker = "cardjail-test-$PID"
  $root = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList "-NoProfile -Command `"Start-Sleep 2; Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -Command Start-Sleep 600 # $marker'; Start-Sleep 3`""
  if (-not $NoJail) { $job = [Jail]::Wrap($root.Id, $CpuSeconds, $null) }
  $root.WaitForExit()
  if (-not $NoJail) { [Jail]::Kill($job) | Out-Null } # the card is over: kill the job
  Start-Sleep 2
  $alive = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $marker -and $_.ProcessId -ne $PID })
  $mode = if ($NoJail) { "without jail" } else { "with jail" }
  if ($alive.Count) { $alive | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Output "RED ($mode): $($alive.Count) grandchild alive after the card ended"; exit 1 }
  Write-Output "GREEN ($mode): no grandchild after the card ended"; exit 0
}

$jobs = @{}  # root pid -> job handle
Say "starting (cpu $CpuSeconds s/process, max handles $MaxHandles)"
while ($true) {
  $all = @(Get-CimInstance Win32_Process)
  $roots = $all | Where-Object { ($_.ExecutablePath -match '\\claude\\versions\\|\\codex' -or $_.Name -match '^(claude|codex)\.exe$') }
  # a CLI that is the child of another CLI is already in its parent's jail
  $rootPids = @($roots | ForEach-Object { $_.ProcessId })
  foreach ($r in $roots) {
    if ($jobs.ContainsKey($r.ProcessId) -or ($rootPids -contains $r.ParentProcessId)) { continue }
    try { $jobs[$r.ProcessId] = [Jail]::Wrap($r.ProcessId, $CpuSeconds, $null); Say "jailed $($r.Name) pid $($r.ProcessId)" }
    catch { $jobs[$r.ProcessId] = [IntPtr]::Zero; Say "not jailed pid $($r.ProcessId): $($_.Exception.Message)" }
  }
  foreach ($k in @($jobs.Keys)) {
    if (-not ($all | Where-Object { $_.ProcessId -eq $k })) {
      if ($jobs[$k] -ne [IntPtr]::Zero -and [Jail]::Kill($jobs[$k])) { Say "card finished (pid $k): job terminated, grandchildren killed" }
      $jobs.Remove($k); continue
    }
    foreach ($d in (Descendants $k $all)) {
      if ($d.HandleCount -gt $MaxHandles) { Stop-Process -Id $d.ProcessId -Force -ErrorAction SilentlyContinue; Say "killed $($d.Name) pid $($d.ProcessId): $($d.HandleCount) handles over $MaxHandles ($($d.CommandLine))" }
    }
  }
  Start-Sleep 5
}
