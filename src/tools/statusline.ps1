# ~/.copilot/statusline.ps1 — Copilot CLI statusline (managed by myelin)
# Shows: dir | branch | myelin proxy status (Copilot-channel compression)
# PS5.1-compatible: uses [char]27 for ESC, not `e (PS6+ only)
$esc = [char]27
$reset = "${esc}[0m"; $dim = "${esc}[2m"; $green = "${esc}[32m"
$cwd = $PWD.Path
$dir = Split-Path $cwd -Leaf
$parts = "${dim}${dir}${reset}"
try {
    $branch = & git -C $cwd --no-optional-locks rev-parse --abbrev-ref HEAD 2>$null
    if ($branch) { $parts += " ${dim}on${reset} ${green}${branch}${reset}" }
} catch {}
try {
    $myelinStatus = & myelin status --no-probe --format prompt 2>$null
    if ($myelinStatus) { $parts += " ${dim}|${reset} ${myelinStatus}" }
} catch {}
[Console]::Write($parts)
