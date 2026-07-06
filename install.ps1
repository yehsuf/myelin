param(
    [string]$Profile = "proxy",
    [string]$IndexTier = "default",
    [switch]$Check,
    [switch]$DryRun,
    [switch]$NoHeadroom,
    [switch]$CopilotOnly,
    [switch]$ClaudeOnly
)
$ErrorActionPreference = "Stop"
$TokenstackDir = if ($env:TOKENSTACK_DIR) { $env:TOKENSTACK_DIR } else { "$env:USERPROFILE\.tokenstack" }
$RepoDir = Join-Path $TokenstackDir "repo"
$RepoUrl = if ($env:TOKENSTACK_REPO_URL) { $env:TOKENSTACK_REPO_URL } else { "https://github.com/ysufrin/tokenstack" }

function Check-Node {
    try {
        $ver = (node --version 2>&1).Trim()
        $major = [int]($ver.TrimStart('v').Split('.')[0])
        if ($major -lt 20) { throw "Node.js $ver < v20" }
        Write-Host "[tokenstack] Node.js $ver OK"
    } catch { Write-Error "Node.js not found or too old. Install from https://nodejs.org (v20+)" }
}
function Check-Git {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Error "git not found." }
}
function Fetch-Repo {
    if (Test-Path (Join-Path $RepoDir ".git")) {
        Write-Host "[tokenstack] Updating..."; git -C $RepoDir pull --ff-only
    } else {
        Write-Host "[tokenstack] Cloning..."; New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir) | Out-Null; git clone $RepoUrl $RepoDir
    }
}

try { $binDir = "$env:USERPROFILE\.tokenstack\bin"; New-Item -Force -Path $binDir -ItemType Directory | Out-Null; Add-MpPreference -ExclusionPath $binDir -ErrorAction SilentlyContinue } catch {}
try { Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -ErrorAction SilentlyContinue } catch {}

Check-Node; Check-Git; Fetch-Repo
Set-Location $RepoDir; npm install --silent

$a = @("src/install.mjs")
if ($Check) { $a += "--check" }; if ($DryRun) { $a += "--dry-run" }; if ($NoHeadroom) { $a += "--no-headroom" }
if ($CopilotOnly) { $a += "--copilot-only" }; if ($ClaudeOnly) { $a += "--claude-only" }
$a += "--profile", $Profile, "--index-tier", $IndexTier
Write-Host "[tokenstack] Running installer..."
node @a
