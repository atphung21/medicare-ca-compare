# Opens the local Medicare Compare app. The desktop shortcut calls start-windows.bat, which runs this script.
$ErrorActionPreference = "Stop"
$InstallDir = "C:\MedicareCompare"
$Url = "http://127.0.0.1:3020/"
$KeyPath = Join-Path $InstallDir ".deploy-key"
$SshExe = "C:\Program Files\Git\usr\bin\ssh.exe"
$BuildId = Join-Path $InstallDir ".next\BUILD_ID"
$BuildLog = Join-Path $InstallDir "build.log"

function Install-Packages {
  Write-Host "Installing packages. This can take a few minutes."
  cmd /c "npm ci 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
  cmd /c "npx playwright install chromium 2>&1"
  if ($LASTEXITCODE -ne 0) { throw "Chromium install failed." }
}

# A failed build leaves .next without BUILD_ID, so the next launch must build again instead of starting.
function Invoke-Build {
  Write-Host "Building Medicare Compare. This can take a few minutes."
  cmd /c "npm run build 2>&1" | Tee-Object -FilePath $BuildLog
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $BuildId)) {
    throw "Build failed. Send $BuildLog to support."
  }
}

function Test-AppRunning {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

if (-not (Test-Path (Join-Path $InstallDir "package.json"))) {
  throw "Medicare Compare is not installed in $InstallDir. Run setup-windows.ps1 to install it."
}
Set-Location $InstallDir

if (Test-AppRunning) {
  Start-Process $Url
  exit 0
}

if ((Test-Path $KeyPath) -and (Test-Path $SshExe)) {
  $ssh = $SshExe -replace "\\", "/"
  $key = $KeyPath -replace "\\", "/"
  $env:GIT_SSH_COMMAND = "`"$ssh`" -i `"$key`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
}

Write-Host "Checking for updates..."
$offline = $false
git fetch origin main
if ($LASTEXITCODE -ne 0) {
  Write-Host "Offline. Opening the last version on this computer."
  $offline = $true
}

if (-not $offline) {
  $local = (git rev-parse HEAD).Trim()
  $remote = (git rev-parse "origin/main").Trim()
  if ($local -ne $remote) {
    Write-Host "Updating Medicare Compare. This can take a few minutes."
    $changed = @(git diff --name-only $local $remote)
    # Nobody edits code on the client PC, so local changes (usually npm rewriting package-lock.json) must not block updates.
    git reset --hard origin/main
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Could not update. Opening the last version on this computer."
    } else {
      $lockChanged = $changed -contains "package-lock.json"
      $appChanged = @($changed | Where-Object {
        $_ -eq "package.json" -or
        $_ -eq "package-lock.json" -or
        $_ -eq "next.config.ts" -or
        $_ -eq "tsconfig.json" -or
        $_ -eq "scripts/patch-opennext-preview-props.mjs" -or
        $_.StartsWith("src/") -or
        $_.StartsWith("public/")
      }).Count -gt 0
      if ($lockChanged) { Install-Packages }
      if ($appChanged) { Invoke-Build }
    }
  }
}

if (-not (Test-Path (Join-Path $InstallDir "node_modules\next"))) { Install-Packages }
if (-not (Test-Path $BuildId)) { Invoke-Build }

Write-Host "Medicare Compare is starting. Close this window when you are finished."
Start-Process -WindowStyle Hidden powershell -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-Command",
  "for (`$i = 0; `$i -lt 90; `$i++) { try { `$r = Invoke-WebRequest -UseBasicParsing '$Url' -TimeoutSec 2; if (`$r.StatusCode -ge 200) { Start-Process '$Url'; exit 0 } } catch { Start-Sleep -Seconds 1 } }"
)
npm start -- -H 127.0.0.1 -p 3020
if ($LASTEXITCODE -ne 0) { throw "The app server stopped." }
