#!/usr/bin/env sh
set -e
TOKENSTACK_DIR="${TOKENSTACK_DIR:-$HOME/.tokenstack}"
REPO_DIR="$TOKENSTACK_DIR/repo"
REPO_URL="${TOKENSTACK_REPO_URL:-https://github.com/ysufrin/tokenstack}"

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "[tokenstack] Node.js not found. Install from https://nodejs.org (v20+)" >&2; exit 1
  fi
  NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
  if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "[tokenstack] Node.js v${NODE_MAJOR} found but v20+ required." >&2; exit 1
  fi
}

check_git() {
  if ! command -v git >/dev/null 2>&1; then
    echo "[tokenstack] git not found." >&2; exit 1
  fi
}

fetch_repo() {
  if [ -d "$REPO_DIR/.git" ]; then
    echo "[tokenstack] Updating..."; git -C "$REPO_DIR" pull --ff-only
  else
    echo "[tokenstack] Cloning..."; mkdir -p "$(dirname "$REPO_DIR")"; git clone "$REPO_URL" "$REPO_DIR"
  fi
}

check_node; check_git; fetch_repo
cd "$REPO_DIR" && npm install --silent
echo "[tokenstack] Running installer..."
node src/install.mjs "$@"
