# One-time setup for a client's Windows PC. Run this from Quick Assist:
#   powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1 -DeployKeyPath C:\Users\Public\Desktop\medicare-deploy-key
# The deploy key is a read-only GitHub deploy key for atphung21/medicare-ca-compare.
# Generate it on your own computer, add the public key in the repo's deploy keys, and copy only the private key to the client for this command.

# Add -KnowledgeToken github_pat_... -Author Eric to share the assistant's team memory (see connect-knowledge.ps1).

param(
  [string]$DeployKeyPath,
  [string]$InstallDir = "C:\MedicareCompare",
  [string]$KnowledgeToken,
  [string]$Author
)

$ErrorActionPreference = "Stop"
$RepoSsh = "git@github.com:atphung21/medicare-ca-compare.git"
$SshExe = "C:\Program Files\Git\usr\bin\ssh.exe"

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Install-WithWinget($id, $commandName) {
  if (Test-Command $commandName) { return $true }
  if (-not (Test-Command "winget")) { return $false }
  Write-Host "Installing $commandName ($id)..."
  winget install --id $id -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
  return (Test-Command $commandName)
}

function Protect-Key($path) {
  icacls $path /inheritance:r | Out-Null
  icacls $path /grant:r "${env:USERDOMAIN}\${env:USERNAME}:(R)" | Out-Null
}

function Get-SshCommand($keyPath) {
  $ssh = $SshExe -replace "\\", "/"
  $key = $keyPath -replace "\\", "/"
  return "`"$ssh`" -i `"$key`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
}

Write-Host "Medicare Compare setup"
if (-not (Install-WithWinget "OpenJS.NodeJS.20" "node")) {
  if (-not (Install-WithWinget "OpenJS.NodeJS.LTS" "node")) {
    throw "Node.js could not be installed. Install Node.js 20, close this window, and run setup again."
  }
}
if (-not (Install-WithWinget "Git.Git" "git")) {
  throw "Git could not be installed. Install Git for Windows, close this window, and run setup again."
}
Refresh-Path

if (-not (Test-Path $SshExe)) {
  throw "Git installed, but $SshExe is missing."
}

if (-not $DeployKeyPath) {
  $candidates = @(
    (Join-Path $InstallDir ".deploy-key"),
    (Join-Path $env:USERPROFILE "Desktop\medicare-deploy-key"),
    (Join-Path $env:USERPROFILE "Desktop\medicare-deploy-key.pem"),
    (Join-Path $env:PUBLIC "Desktop\medicare-deploy-key"),
    (Join-Path $env:PUBLIC "Desktop\medicare-deploy-key.pem")
  )
  $DeployKeyPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $DeployKeyPath -or -not (Test-Path $DeployKeyPath)) {
  throw "Copy the read-only deploy private key onto this PC and pass -DeployKeyPath."
}

$stagingKey = Join-Path $env:TEMP "medicare-compare-deploy-key"
Copy-Item -LiteralPath $DeployKeyPath -Destination $stagingKey -Force
Protect-Key $stagingKey
$env:GIT_SSH_COMMAND = Get-SshCommand $stagingKey

$gitDir = Join-Path $InstallDir ".git"
if (-not (Test-Path $gitDir)) {
  if (Test-Path $InstallDir) {
    $existing = Get-ChildItem -Force $InstallDir | Where-Object { $_.Name -ne ".deploy-key" }
    if ($existing) {
      throw "$InstallDir already exists and is not the Medicare Compare checkout."
    }
  }
  Write-Host "Cloning Medicare Compare..."
  git clone $RepoSsh $InstallDir
  if ($LASTEXITCODE -ne 0) { throw "Clone failed. Confirm the deploy key is read-only on atphung21/medicare-ca-compare." }
}

$keyDest = Join-Path $InstallDir ".deploy-key"
Copy-Item -LiteralPath $stagingKey -Destination $keyDest -Force
Protect-Key $keyDest
$env:GIT_SSH_COMMAND = Get-SshCommand $keyDest
git -C $InstallDir config core.sshCommand (Get-SshCommand $keyDest)

$envFile = Join-Path $InstallDir ".env.local"
if (-not (Test-Path $envFile)) {
  Set-Content -LiteralPath $envFile -Value "PLAYWRIGHT_HEADLESS=false`r`n" -Encoding ascii
  Write-Host "Wrote $envFile. Add GEMINI_API_KEY on its own line for the assistant and pill-bottle photos."
}
if ($KnowledgeToken) {
  if (-not $Author) { $Author = $env:USERNAME }
  & (Join-Path $InstallDir "scripts\client\connect-knowledge.ps1") -Token $KnowledgeToken -Author $Author -InstallDir $InstallDir
  if ($LASTEXITCODE -ne 0) { Write-Host "Setup continues; run connect-knowledge.ps1 again once the token works." }
}

Push-Location $InstallDir
try {
  Write-Host "Installing the app and Chromium..."
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
  npx playwright install chromium
  if ($LASTEXITCODE -ne 0) { throw "Chromium install failed." }
  $buildLog = Join-Path $InstallDir "build.log"
  cmd /c "npm run build 2>&1" | Tee-Object -FilePath $buildLog
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $InstallDir ".next\BUILD_ID"))) {
    throw "Build failed. Send $buildLog to support."
  }
} finally {
  Pop-Location
}

$starter = Join-Path $InstallDir "scripts\client\start-windows.bat"
if (-not (Test-Path $starter)) {
  throw "The checkout does not include scripts\client\start-windows.bat. Push that file to main, then run setup again."
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Medicare Compare.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $starter
$shortcut.WorkingDirectory = $InstallDir
$shortcut.WindowStyle = 1
$shortcut.Description = "Open Medicare Compare"
$shortcut.Save()

Write-Host "Setup finished. The desktop shortcut is Medicare Compare."
Write-Host "Push later updates to main. The client double-clicks that shortcut to open the latest version."
