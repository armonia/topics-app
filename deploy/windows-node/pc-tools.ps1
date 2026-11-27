# Brings the PC to have every tool listed in node-tools.txt (idempotent).
# Launched by node-prep from the paired machine (at most once a day or when the list changes);
# with -VerifyOnly the acceptance bar uses it. Prints "OK name" / "MISSING name: reason"; exit 1 if one is missing.
param(
  [string]$List = $(Join-Path $(if ($env:TOPICS_NODE_DIR) { $env:TOPICS_NODE_DIR } else { "C:\topics-node" }) "node-tools.txt"),
  [switch]$VerifyOnly
)
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

# winget and npm update PATH in the registry, not in this process: re-read it after every install.
function Reload-Path {
  $m = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $u = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$m;$u;$env:USERPROFILE\.bun\bin;$env:APPDATA\npm;$env:LOCALAPPDATA\Microsoft\WinGet\Links"
}
function Has-Command($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Reload-Path
$missing = 0
foreach ($line in Get-Content $List) {
  $r = $line.Trim()
  if (-not $r -or $r.StartsWith("#")) { continue }
  $c = $r -split "\s+"
  $name, $cmd, $wg, $npm = $c[0], $c[1], $c[2], $c[4]
  if ($wg -eq "-" -and $npm -eq "-") { continue }  # Linux only
  if (Has-Command $cmd) { "OK $name"; continue }
  if (-not $VerifyOnly) {
    if ($wg -ne "-") {
      winget install --id $wg -e --silent --scope user --accept-package-agreements --accept-source-agreements --disable-interactivity *> $null
      if ($LASTEXITCODE -ne 0) { winget install --id $wg -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity *> $null }
    } elseif ($npm -ne "-") {
      npm install -g --silent $npm *> $null
    }
    Reload-Path
    if (Has-Command $cmd) { "OK $name (installed now)"; continue }
  }
  "MISSING ${name}: command '$cmd' not found" + $(if ($VerifyOnly) { "" } else { " even after the install" })
  $missing++
}
# Git login for the agents. Git for Windows' system gitconfig uses the "manager"
# helper (GCM on wincredman), which from the agent's process neither reads nor
# saves: "Unable to persist credentials", and every fetch fails.
# gh is already logged in: it becomes the helper for github.com.
if (-not $VerifyOnly -and (Has-Command "gh")) { gh auth setup-git --hostname github.com *> $null }

# Check with the agent's cleaned environment (agent-env.ts of topics-app):
# only these variables, prompts off.
$keep = 'PATH','APPDATA','LOCALAPPDATA','USERPROFILE','HOMEDRIVE','HOMEPATH','SystemRoot','SystemDrive','windir','ComSpec','PATHEXT','TEMP','TMP','ProgramData','ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles','USERNAME','USERDOMAIN','COMPUTERNAME','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','OS'
function Run-AsAgent($exe, $arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = $arguments
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables.Clear()
  foreach ($k in $keep) { $v = [Environment]::GetEnvironmentVariable($k); if ($v) { $psi.EnvironmentVariables[$k] = $v } }
  $psi.EnvironmentVariables['HOME'] = $env:USERPROFILE
  $psi.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
  $psi.EnvironmentVariables['GCM_INTERACTIVE'] = 'Never'
  $p = [Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEnd() + $p.StandardError.ReadToEnd()
  if (-not $p.WaitForExit(60000)) { $p.Kill(); return @(124, "timeout") }
  return @($p.ExitCode, $out)
}
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if ($gh -and $git) {
  $r = Run-AsAgent $gh "auth status"
  if ($r[0] -ne 0) { "MISSING gh-agent-login: gh auth status rc=$($r[0])"; $missing++ } else { "OK gh-agent-login" }
  $repo = Get-ChildItem (Join-Path (Split-Path $List) "repos") -Directory -ErrorAction SilentlyContinue |
    Get-ChildItem -Directory | Where-Object { Test-Path (Join-Path $_.FullName ".git") } | Select-Object -First 1
  if ($repo) {
    $r = Run-AsAgent $git "-C `"$($repo.FullName)`" ls-remote origin HEAD"
    if ($r[0] -ne 0) { "MISSING git-agent-login: git ls-remote origin in $($repo.Name) rc=$($r[0]): $(($r[1] -split "`n")[0])"; $missing++ } else { "OK git-agent-login ($($repo.Name))" }
  }
}
if ($missing) { exit 1 } else { exit 0 }
