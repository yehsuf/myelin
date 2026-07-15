#!/usr/bin/env sh
set -e

# Canonicalize an explicit MYELIN_DIR the SAME way Node's resolveMyelinRoot does,
# so this shell installer and the staged Node runtime always target the same
# managed root:
#   - a leading `~` or `~/` expands to $HOME,
#   - any still-relative value is rooted at $HOME (never the cwd),
#   - an already-absolute value passes through unchanged.
# Without this, `MYELIN_DIR=~/foo` or `MYELIN_DIR=foo` would be staged verbatim
# here while Node canonicalized it against $HOME — pointing the two at different
# directories.
canonicalize_myelin_dir() {
  _root="$1"
  case "$_root" in
    '~')   printf '%s\n' "$HOME" ;;
    '~/'*) printf '%s\n' "$HOME${_root#\~}" ;;
    /*)    printf '%s\n' "$_root" ;;
    *)     printf '%s\n' "$HOME/$_root" ;;
  esac
}

MYELIN_DIR="$(canonicalize_myelin_dir "${MYELIN_DIR:-$HOME/.myelin}")"
export MYELIN_DIR
REPO_URL="${MYELIN_REPO_URL:-https://github.com/yehsuf/myelin}"

# --dry-run and --check are non-activating: stage/validate a candidate but never
# switch the active runtime by writing the current-release pointer.
ACTIVATE=1
for arg in "$@"; do
  case "$arg" in
    --dry-run|--check) ACTIVATE=0 ;;
  esac
done

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "[myelin] Node.js not found. Install from https://nodejs.org (v20+)" >&2; exit 1
  fi
  NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
  if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "[myelin] Node.js v${NODE_MAJOR} found but v20+ required." >&2; exit 1
  fi
}

check_git() {
  if ! command -v git >/dev/null 2>&1; then
    echo "[myelin] git not found." >&2; exit 1
  fi
}

json_escape() {
  # Escape a value for safe embedding inside a JSON string literal: backslash
  # first, then double-quote. A managed root/release id with `"` or `\` would
  # otherwise corrupt current.json.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

write_current_release_pointer() {
  RELEASE_ID="$1"
  RUNTIME_ROOT="$2"
  CURRENT_POINTER="$MYELIN_DIR/current.json"
  TEMP_POINTER="$CURRENT_POINTER.$$".tmp

  ESC_RELEASE_ID="$(json_escape "$RELEASE_ID")"
  ESC_RUNTIME_ROOT="$(json_escape "$RUNTIME_ROOT")"

  mkdir -p "$MYELIN_DIR"
  cat > "$TEMP_POINTER" <<EOF
{
  "version": 1,
  "releaseId": "$ESC_RELEASE_ID",
  "runtimeRoot": "$ESC_RUNTIME_ROOT"
}
EOF
  mv "$TEMP_POINTER" "$CURRENT_POINTER"
}

stage_main_runtime() {
  RELEASES_DIR="$MYELIN_DIR/releases"
  STAGE_DIR="$MYELIN_DIR/releases-stage-main-$$-$(date +%s)"

  mkdir -p "$MYELIN_DIR" "$RELEASES_DIR"
  trap 'if [ -n "${STAGE_DIR:-}" ] && [ -d "$STAGE_DIR" ]; then rm -rf "$STAGE_DIR"; fi' EXIT INT TERM HUP

  echo "[myelin] Staging main runtime..."
  git clone --depth 1 --branch main "$REPO_URL" "$STAGE_DIR"
  COMMIT="$(git -C "$STAGE_DIR" rev-parse --short=12 HEAD)"
  RELEASE_ID="main-$COMMIT"
  RUNTIME_ROOT="$RELEASES_DIR/$RELEASE_ID"

  if [ -d "$RUNTIME_ROOT" ]; then
    if [ -f "$RUNTIME_ROOT/src/cli/index.mjs" ] && [ -d "$RUNTIME_ROOT/node_modules" ]; then
      echo "[myelin] Reusing managed runtime $RELEASE_ID"
      rm -rf "$STAGE_DIR"
      STAGE_DIR=""
      if [ "$ACTIVATE" = "1" ]; then
        write_current_release_pointer "$RELEASE_ID" "$RUNTIME_ROOT"
      fi
      trap - EXIT INT TERM HUP
      return 0
    fi

    rm -rf "$RUNTIME_ROOT"
  fi

  (
    cd "$STAGE_DIR"
    npm ci --ignore-scripts
    node --check src/cli/index.mjs
  )

  mv "$STAGE_DIR" "$RUNTIME_ROOT"
  STAGE_DIR=""
  if [ "$ACTIVATE" = "1" ]; then
    write_current_release_pointer "$RELEASE_ID" "$RUNTIME_ROOT"
  fi
  trap - EXIT INT TERM HUP
}

check_node
check_git
stage_main_runtime
echo "[myelin] Running staged installer..."
node "$RUNTIME_ROOT/src/install.mjs" "$@"
