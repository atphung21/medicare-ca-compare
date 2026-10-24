# Connects this PC's assistant to the team memory, so what it learns is shared with every other computer.
#   powershell -ExecutionPolicy Bypass -File C:\MedicareCompare\scripts\client\connect-knowledge.ps1 -Token github_pat_... -Author Eric
# The token is a fine-grained GitHub token limited to the knowledge repo with Contents read and write. It cannot change the app's code.

param(
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$Author,
  [string]$Repo = "atphung21/medicare-agent-knowledge",
  [string]$InstallDir = "C:\MedicareCompare"
)

$ErrorActionPreference = "Stop"
$envFile = Join-Path $InstallDir ".env.local"
$settings = [ordered]@{
  KNOWLEDGE_REPO = $Repo.Trim()
  KNOWLEDGE_TOKEN = $Token.Trim()
  KNOWLEDGE_AUTHOR = $Author.Trim()
}

$lines = @()
if (Test-Path $envFile) {
  $lines = @(Get-Content -LiteralPath $envFile | Where-Object { $_ -notmatch "^\s*KNOWLEDGE_(REPO|TOKEN|AUTHOR)\s*=" })
}
foreach ($name in $settings.Keys) { $lines += "$name=$($settings[$name])" }
Set-Content -LiteralPath $envFile -Value $lines -Encoding ascii

Write-Host "Checking the token against $Repo..."
try {
  $headers = @{ Authorization = "Bearer $($settings.KNOWLEDGE_TOKEN)"; Accept = "application/vnd.github+json" }
  $repoInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo" -Headers $headers -TimeoutSec 15
  if (-not $repoInfo.permissions.push) { throw "The token can read $Repo but not write to it. Give it Contents read and write." }
  Write-Host "Team memory connected as $Author. Close Medicare Compare and open it again to start sharing."
} catch {
  Write-Host "Saved the settings, but GitHub did not accept the token: $($_.Exception.Message)"
  Write-Host "Check that the token has access to $Repo with Contents read and write, then run this again."
  exit 1
}
