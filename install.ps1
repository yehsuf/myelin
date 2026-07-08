param(
    [string]$Preset = "proxy",
    [string]$IndexTier = "default",
    [switch]$Check,
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$NoHeadroom,
    [switch]$CopilotOnly,
    [switch]$ClaudeOnly
)
$ErrorActionPreference = "Stop"
$MyelinDir = if ($env:MYELIN_DIR) { $env:MYELIN_DIR } else { "$env:USERPROFILE\.myelin" }
$RepoDir = Join-Path $MyelinDir "repo"
$RepoUrl = if ($env:MYELIN_REPO_URL) { $env:MYELIN_REPO_URL } else { "https://github.com/yehsuf/myelin" }

function Check-Node {
    try {
        $ver = (node --version 2>&1).Trim()
        $major = [int]($ver.TrimStart('v').Split('.')[0])
        if ($major -lt 20) { throw "Node.js $ver < v20" }
        Write-Host "[myelin] Node.js $ver OK"
    } catch { Write-Error "Node.js not found or too old. Install from https://nodejs.org (v20+)" }
}
function Check-Git {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Error "git not found." }
}
function Fetch-Repo {
    if (Test-Path (Join-Path $RepoDir ".git")) {
        Write-Host "[myelin] Updating..."; git -C $RepoDir pull --ff-only
    } else {
        Write-Host "[myelin] Cloning..."; New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir) | Out-Null; git clone $RepoUrl $RepoDir
    }
}

try { $binDir = "$env:USERPROFILE\.myelin\bin"; New-Item -Force -Path $binDir -ItemType Directory | Out-Null; Add-MpPreference -ExclusionPath $binDir -ErrorAction SilentlyContinue } catch {}
# Whitelist powershell.exe and node.exe for Controlled Folder Access
try { Add-MpPreference -ControlledFolderAccessAllowedApplications (Get-Command node -ErrorAction SilentlyContinue).Source -ErrorAction SilentlyContinue } catch {}
try { Add-MpPreference -ControlledFolderAccessAllowedApplications "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ErrorAction SilentlyContinue } catch {}
try { Add-MpPreference -ControlledFolderAccessAllowedApplications "$env:SystemRoot\System32\robocopy.exe" -ErrorAction SilentlyContinue } catch {}
try { Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -ErrorAction SilentlyContinue } catch {}

Check-Node; Check-Git; Fetch-Repo
Set-Location $RepoDir
Write-Host "[myelin] Installing npm dependencies..."
npm install --registry https://registry.npmjs.org
if ($LASTEXITCODE -ne 0) { Write-Error "npm install failed"; exit 1 }
Write-Host "[myelin] npm install complete."

$a = @("src/install.mjs")
if ($Check) { $a += "--check" }; if ($DryRun) { $a += "--dry-run" }; if ($Yes) { $a += "--yes" }
if ($NoHeadroom) { $a += "--no-headroom" }
if ($CopilotOnly) { $a += "--copilot-only" }; if ($ClaudeOnly) { $a += "--claude-only" }
$a += "--profile", $Preset, "--index-tier", $IndexTier
Write-Host "[myelin] Running installer..."
node @a
