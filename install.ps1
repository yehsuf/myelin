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

# Canonicalize an explicit MYELIN_DIR the SAME way install.sh's
# canonicalize_myelin_dir / Node's resolveMyelinRoot do, so this PowerShell
# installer and the staged Node runtime always target the same managed root:
#   - a leading ~ (optionally ~/ or ~\) expands to $env:USERPROFILE,
#   - any still-relative value is rooted at $env:USERPROFILE (never the CWD),
#   - an already-absolute value (drive-rooted, UNC, or rooted) passes through.
# Without this, `MYELIN_DIR=~\foo` or `MYELIN_DIR=foo` would be staged under the
# CWD here while Node canonicalized it against $env:USERPROFILE — a fragmented
# install pointing the two at different directories.
function Canonicalize-MyelinDir {
    param([string]$Root)
    if ($Root -eq '~') { return $env:USERPROFILE }
    if ($Root -match '^~[\\/](.*)$') {
        if ($Matches[1] -eq '') { return $env:USERPROFILE }
        return (Join-Path $env:USERPROFILE $Matches[1])
    }
    if ($Root -match '^[A-Za-z]:[\\/]' -or $Root -match '^[\\/]{2}' -or $Root -match '^[\\/]') { return $Root }
    return (Join-Path $env:USERPROFILE $Root)
}

# A null / empty / WHITESPACE-only MYELIN_DIR is treated as ABSENT and falls back
# to the default managed root BEFORE canonicalization — mirroring Node's
# resolveMyelinRoot, whose `value.trim() ? value : undefined` guard treats a
# blank value as unset. Without this, `if ($env:MYELIN_DIR)` sees a whitespace-only
# string as truthy and Canonicalize-MyelinDir would root it at USERPROFILE
# (`<USERPROFILE>\   `), diverging from the staged Node runtime's `<home>\.myelin`.
$MyelinDir = if ([string]::IsNullOrWhiteSpace($env:MYELIN_DIR)) { "$env:USERPROFILE\.myelin" } else { $env:MYELIN_DIR }
$MyelinDir = Canonicalize-MyelinDir $MyelinDir
$env:MYELIN_DIR = $MyelinDir
$RepoUrl = if ($env:MYELIN_REPO_URL) { $env:MYELIN_REPO_URL } else { "https://github.com/yehsuf/myelin" }

# -DryRun and -Check are non-activating: stage/validate a candidate but never
# switch the active runtime by writing the current-release pointer.
$Activate = -not ($DryRun -or $Check)

function Check-Node {
    # If fnm is installed, use it to activate the pinned Node version first.
    # fnm env --use-on-cd doesn't help in scripts, so call it explicitly.
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
        [int]((node --version 2>&1).TrimStart('v').Split('.')[0]) -lt 20) {
        if (Get-Command fnm -ErrorAction SilentlyContinue) {
            # fnm reads .nvmrc/.node-version; fall back to explicit 20 install if needed
            try { fnm use 2>$null } catch {}
            if ($LASTEXITCODE -ne 0) {
                try { fnm install 20 2>$null; fnm use 20 2>$null } catch {}
            }
        } elseif (Get-Command nvm -ErrorAction SilentlyContinue) {
            # nvm-windows does NOT read .nvmrc/.node-version automatically;
            # must specify the version explicitly. Install then activate.
            try { nvm install 20 2>$null } catch {}
            try { nvm use 20 2>$null } catch {}
        }
    }
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
function Write-CurrentReleasePointer {
    param(
        [Parameter(Mandatory = $true)][string]$ReleaseId,
        [Parameter(Mandatory = $true)][string]$RuntimeRoot
    )

    $currentPointer = Join-Path $MyelinDir "current.json"
    $tempPointer = "$currentPointer.$PID.tmp"
    $pointer = @{
        version = 1
        releaseId = $ReleaseId
        runtimeRoot = $RuntimeRoot
    } | ConvertTo-Json

    New-Item -ItemType Directory -Force -Path $MyelinDir | Out-Null
    [System.IO.File]::WriteAllText($tempPointer, $pointer + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempPointer -Destination $currentPointer -Force
}

function Stage-MainRuntime {
    $releasesDir = Join-Path $MyelinDir "releases"
    $stageDir = Join-Path $MyelinDir ("releases-stage-main-{0}-{1}" -f $PID, [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())

    New-Item -ItemType Directory -Force -Path $MyelinDir, $releasesDir | Out-Null

    try {
        Write-Host "[myelin] Staging main runtime..."
        git clone --depth 1 --branch main $RepoUrl $stageDir
        if ($LASTEXITCODE -ne 0) { throw "git clone failed" }

        $commit = (git -C $stageDir rev-parse --short=12 HEAD).Trim()
        if ($LASTEXITCODE -ne 0) { throw "git rev-parse failed" }

        $releaseId = "main-$commit"
        $runtimeRoot = Join-Path $releasesDir $releaseId
        $entrypoint = Join-Path $runtimeRoot "src\cli\index.mjs"
        $nodeModules = Join-Path $runtimeRoot "node_modules"

        if (Test-Path $runtimeRoot) {
            if ((Test-Path $entrypoint -PathType Leaf) -and (Test-Path $nodeModules -PathType Container)) {
                Write-Host "[myelin] Reusing managed runtime $releaseId"
                Remove-Item -LiteralPath $stageDir -Recurse -Force
                if ($Activate) { Write-CurrentReleasePointer -ReleaseId $releaseId -RuntimeRoot $runtimeRoot }
                # Use script-scoped variable — avoids pipeline-capture gotcha where
                # any stdout produced inside the function would be captured as part
                # of the return value when the caller does $x = Stage-MainRuntime.
                $Script:RuntimeRoot = $runtimeRoot
                return
            }

            Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
        }

        Push-Location $stageDir
        try {
            npm ci --ignore-scripts
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

            node --check src/cli/index.mjs
            if ($LASTEXITCODE -ne 0) { throw "node --check failed" }
        } finally {
            Pop-Location
        }

        Move-Item -LiteralPath $stageDir -Destination $runtimeRoot
        $stageDir = $null
        if ($Activate) { Write-CurrentReleasePointer -ReleaseId $releaseId -RuntimeRoot $runtimeRoot }
        $Script:RuntimeRoot = $runtimeRoot
    } catch {
        if ($stageDir -and (Test-Path $stageDir)) {
            Remove-Item -LiteralPath $stageDir -Recurse -Force
        }
        throw
    }
}

try { $binDir = Join-Path $MyelinDir 'bin'; New-Item -Force -Path $binDir -ItemType Directory | Out-Null; Add-MpPreference -ExclusionPath $binDir -ErrorAction SilentlyContinue } catch {}
# Whitelist powershell.exe and node.exe for Controlled Folder Access
try { Add-MpPreference -ControlledFolderAccessAllowedApplications (Get-Command node -ErrorAction SilentlyContinue).Source -ErrorAction SilentlyContinue } catch {}
try { Add-MpPreference -ControlledFolderAccessAllowedApplications "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ErrorAction SilentlyContinue } catch {}
try { Add-MpPreference -ControlledFolderAccessAllowedApplications "$env:SystemRoot\System32\robocopy.exe" -ErrorAction SilentlyContinue } catch {}
try { Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -ErrorAction SilentlyContinue } catch {}

$Script:RuntimeRoot = $null
Check-Node; Check-Git; Stage-MainRuntime

$RuntimeRoot = $Script:RuntimeRoot

$a = @((Join-Path $RuntimeRoot "src\install.mjs"))
if ($Check) { $a += "--check" }; if ($DryRun) { $a += "--dry-run" }; if ($Yes) { $a += "--yes" }
if ($NoHeadroom) { $a += "--no-headroom" }
if ($CopilotOnly) { $a += "--copilot-only" }; if ($ClaudeOnly) { $a += "--claude-only" }
$a += "--profile", $Preset, "--index-tier", $IndexTier
Write-Host "[myelin] Running staged installer..."
node @a
