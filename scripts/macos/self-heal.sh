#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/macos/common.sh
. "$SCRIPT_DIR/common.sh"

BASE_DIR="$HOME/.antigravity-i18n"
ASAR_PATH=""
PROCESS_NAME="Antigravity"
NO_WAIT=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-dir) BASE_DIR="$2"; shift 2 ;;
    --asar-path) ASAR_PATH="$2"; shift 2 ;;
    --process-name) PROCESS_NAME="$2"; shift 2 ;;
    --no-wait) NO_WAIT=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ASAR_PATH" ]; then
  APP_PATH="$(resolve_app_bundle)"
  ASAR_PATH="$APP_PATH/Contents/Resources/app.asar"
fi

if [ ! -f "$ASAR_PATH" ]; then
  exit 0
fi

if [ "$(get_asar_patch_status "$BASE_DIR" "$ASAR_PATH")" = "patched" ]; then
  exit 0
fi

if ! enter_i18n_lock "$BASE_DIR" 0; then
  exit 0
fi

cleanup() {
  exit_i18n_lock "$BASE_DIR"
}
trap cleanup EXIT

if [ "$(get_asar_patch_status "$BASE_DIR" "$ASAR_PATH")" = "patched" ]; then
  exit 0
fi

if test_target_running "$PROCESS_NAME"; then
  write_i18n_log "$BASE_DIR" "Detected unpatched Antigravity while running. Sending notification."
  show_i18n_toast "$BASE_DIR"
  if [ "$NO_WAIT" -eq 1 ]; then
    exit 0
  fi
  exit_i18n_lock "$BASE_DIR"
  while test_target_running "$PROCESS_NAME"; do
    sleep 2
  done
  if ! enter_i18n_lock "$BASE_DIR" 10; then
    exit 0
  fi
fi

if [ "$(get_asar_patch_status "$BASE_DIR" "$ASAR_PATH")" != "patched" ]; then
  patch_asar_and_sign "$BASE_DIR" "$ASAR_PATH"
fi
