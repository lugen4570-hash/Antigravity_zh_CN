#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_URL="${ARCHIVE_URL:-https://github.com/lugen4570-hash/Antigravity_zh_CN/archive/refs/heads/main.tar.gz}"
BASE_DIR="${BASE_DIR:-$HOME/.antigravity-i18n}"
ASAR_PATH="${ASAR_PATH:-}"
APP_PATH="${APP_PATH:-}"
PROCESS_NAME="${PROCESS_NAME:-Antigravity}"
SKIP_AGENT_REGISTER=0
SKIP_PATCH=0
NO_WAIT=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive-url) ARCHIVE_URL="$2"; shift 2 ;;
    --base-dir) BASE_DIR="$2"; shift 2 ;;
    --app-path) APP_PATH="$2"; shift 2 ;;
    --asar-path) ASAR_PATH="$2"; shift 2 ;;
    --process-name) PROCESS_NAME="$2"; shift 2 ;;
    --skip-agent-register) SKIP_AGENT_REGISTER=1; shift ;;
    --skip-patch) SKIP_PATCH=1; shift ;;
    --no-wait) NO_WAIT=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>= 18) is required. Install via https://nodejs.org/ or 'brew install node'." >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/antigravity-zh-cn.XXXXXX")"
cleanup() {
  rm -rf "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

ARCHIVE_FILE="$TMP_ROOT/repo.tar.gz"
EXTRACT_DIR="$TMP_ROOT/src"
mkdir -p "$EXTRACT_DIR"

echo "[1/3] Downloading Antigravity_zh_CN..."
curl -fsSL "$ARCHIVE_URL" -o "$ARCHIVE_FILE"

echo "[2/3] Extracting package..."
tar -xzf "$ARCHIVE_FILE" -C "$EXTRACT_DIR"

INSTALL_SH="$(find "$EXTRACT_DIR" -type f -path '*/scripts/macos/install.sh' | head -n 1)"
if [ -z "$INSTALL_SH" ]; then
  echo "Error: Could not find scripts/macos/install.sh inside archive." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$INSTALL_SH")/../.." && pwd)"
echo "[3/3] Installing Antigravity Chinese localization..."

ARGS=(--source-dir "$REPO_ROOT" --base-dir "$BASE_DIR" --process-name "$PROCESS_NAME")
[ -n "$APP_PATH" ] && ARGS+=(--app-path "$APP_PATH")
[ -n "$ASAR_PATH" ] && ARGS+=(--asar-path "$ASAR_PATH")
[ "$SKIP_AGENT_REGISTER" -eq 1 ] && ARGS+=(--skip-agent-register)
[ "$SKIP_PATCH" -eq 1 ] && ARGS+=(--skip-patch)
[ "$NO_WAIT" -eq 1 ] && ARGS+=(--no-wait)

/bin/bash "$INSTALL_SH" "${ARGS[@]}"
echo "Done! Quit (Cmd+Q) and reopen Antigravity if it is currently open."
