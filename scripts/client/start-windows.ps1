# Opens the local Medicare Compare app. The desktop shortcut calls start-windows.bat, which runs this script.
$ErrorActionPreference = "Stop"
$InstallDir = "C:\MedicareCompare"
$Url = "http://127.0.0.1:3020/"
$KeyPath = Join-Path $InstallDir ".deploy-key"
$SshExe = "C:\Program Files\Git\usr\bin\ssh.exe"

function Test-AppRunning {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
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
    git pull --ff-only origin main
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
      if ($lockChanged) {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
        npx playwright install chromium
        if ($LASTEXITCODE -ne 0) { throw "Chromium install failed." }
      }
      if ($appChanged) {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Build failed." }
      }
    }
  }
}

Write-Host "Medicare Compare is starting. Close this window when you are finished."
Start-Process -WindowStyle Hidden powershell -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-Command",
  "for (`$i = 0; `$i -lt 90; `$i++) { try { `$r = Invoke-WebRequest -UseBasicParsing '$Url' -TimeoutSec 2; if (`$r.StatusCode -ge 200) { Start-Process '$Url'; exit 0 } } catch { Start-Sleep -Seconds 1 } }"
)
npm start -- -H 127.0.0.1 -p 3020
if ($LASTEXITCODE -ne 0) { throw "The app server stopped." }
