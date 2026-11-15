# Claude Code Stats installer for Windows (PowerShell 5.1 or 7).
#   irm https://raw.githubusercontent.com/AIInnovator/claude-stats/main/install.ps1 | iex
#
# 1. Installs the current Node.js LTS with winget when Node 22 or newer is missing.
# 2. Downloads the latest release into %USERPROFILE%\.claude-stats (re-run to update; it replaces only that folder).
# 3. Starts the dashboard on http://127.0.0.1:7420 (Ctrl+C stops it).
#
# Options (environment variables): CLAUDE_STATS_DIR=<folder> installs elsewhere,
# CLAUDE_STATS_NO_START=1 installs without starting.

# a script block, so nothing it defines is left behind in your PowerShell session
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with the progress bar (PowerShell 5.1)
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo = 'AIInnovator/claude-stats'
  $Dir = if ($env:CLAUDE_STATS_DIR) { $env:CLAUDE_STATS_DIR } else { Join-Path $HOME '.claude-stats' }
  $Need = 22

  function Say($Text) { Write-Host '==> ' -NoNewline -ForegroundColor Cyan; Write-Host $Text }
  function NodeMajor {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return 0 }
    try { return [int](((& node --version) -replace '^v', '') -split '\.')[0] } catch { return 0 }
  }
  function RefreshPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }

  # 1. Node.js
  if ((NodeMajor) -lt $Need) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw "Node.js $Need or newer is needed. Install the LTS from https://nodejs.org, then run this again."
    }
    Say "Node.js $Need or newer is needed: installing the current LTS with winget"
    $wingetArgs = @('--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements')
    winget install @wingetArgs
    RefreshPath
    # an older LTS that winget installed earlier is upgraded, not installed again
    if ((NodeMajor) -lt $Need) { winget upgrade @wingetArgs; RefreshPath }
    if ((NodeMajor) -lt $Need) { throw "Node.js $Need+ is still not available. Open a new terminal and run this again." }
  }
  Say "Node.js $(& node --version)"

  # 2. The latest release (the main branch if there is none yet)
  $Tag = try { (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'claude-stats-installer' }).tag_name } catch { $null }
  $Ref = if ($Tag) { "tags/$Tag" } else { 'heads/main' }
  Say "Downloading claude-stats $(if ($Tag) { $Tag } else { 'main' })"
  # next to the install folder: same drive, so the final move never crosses volumes
  $Tmp = "$Dir.download.$PID"
  if (Test-Path $Tmp) { Remove-Item $Tmp -Recurse -Force }
  New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
  try {
    $Zip = Join-Path $Tmp 'claude-stats.zip'
    Invoke-WebRequest "https://github.com/$Repo/archive/refs/$Ref.zip" -OutFile $Zip -UseBasicParsing
    Expand-Archive -Path $Zip -DestinationPath $Tmp
    $Src = Get-ChildItem -Path $Tmp -Directory | Select-Object -First 1
    if (-not $Src -or -not (Test-Path (Join-Path $Src.FullName 'server.mjs'))) { throw 'The download does not look like claude-stats.' }

    # replace an earlier install, never a folder that is something else
    if (Test-Path $Dir) {
      $Pkg = Join-Path $Dir 'package.json'
      if (-not ((Test-Path $Pkg) -and (Select-String -Path $Pkg -Pattern '"name": "claude-stats"' -Quiet))) {
        throw "$Dir exists and is not a claude-stats install. Set CLAUDE_STATS_DIR to another folder."
      }
      Remove-Item $Dir -Recurse -Force
    }
    Move-Item -Path $Src.FullName -Destination $Dir
  } finally {
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  Say "Installed in $Dir"

  # 3. Start
  $Server = Join-Path $Dir 'server.mjs'
  if ($env:CLAUDE_STATS_NO_START -eq '1') { Say "Start it with: node `"$Server`""; return }
  Say "Starting: open http://127.0.0.1:7420 once it prints its address (Ctrl+C stops it; start again with: node `"$Server`")"
  & node $Server
}
