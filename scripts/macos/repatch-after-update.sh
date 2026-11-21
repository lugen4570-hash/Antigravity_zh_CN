#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/macos/common.sh
. "$SCRIPT_DIR/common.sh"

OLD_PID=0
ASAR_PATH=""
EXE_PATH=""
OLD_HASH=""
RELAUNCH=0
BASE_DIR="$HOME/.antigravity-i18n"
PROCESS_NAME="Antigravity"
SKIP_RELAUNCH=0
MAX_WAIT_SECONDS=300

while [ "$#" -gt 0 ]; do
  case "$1" in
    --old-pid) OLD_PID="$2"; shift 2 ;;
    --asar-path) ASAR_PATH="$2"; shift 2 ;;
    --exe-path) EXE_PATH="$2"; shift 2 ;;
    --old-hash) OLD_HASH="$2"; shift 2 ;;
    --relaunch) RELAUNCH="$2"; shift 2 ;;
    --base-dir) BASE_DIR="$2"; shift 2 ;;
    --process-name) PROCESS_NAME="$2"; shift 2 ;;
    --skip-relaunch) SKIP_RELAUNCH=1; shift ;;
    --max-wait-seconds) MAX_WAIT_SECONDS="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ASAR_PATH" ]; then
  APP_PATH="$(resolve_app_bundle)"
  ASAR_PATH="$APP_PATH/Contents/Resources/app.asar"
fi

if ! enter_i18n_lock "$BASE_DIR" "$MAX_WAIT_SECONDS"; then
  write_i18n_log "$BASE_DIR" "Timed out waiting for i18n lock."
  exit 1
fi

cleanup() {
  exit_i18n_lock "$BASE_DIR"
}
trap cleanup EXIT

write_i18n_log "$BASE_DIR" "macOS repatch bridge started (OldPid=$OLD_PID, Relaunch=$RELAUNCH)."

NOW_SEC="$(date +%s)"
DEADLINE=$((NOW_SEC + MAX_WAIT_SECONDS))

if [ "$OLD_PID" -gt 0 ] 2>/dev/null; then
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    if ! kill -0 "$OLD_PID" 2>/dev/null; then
      break
    fi
    sleep 0.35 2>/dev/null || sleep 1
  done
fi

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -f "$ASAR_PATH" ]; then
    CUR_HASH="$(get_file_sha256 "$ASAR_PATH")"
    STATUS="$(get_asar_patch_status "$BASE_DIR" "$ASAR_PATH")"
    if [ "$STATUS" = "unpatched" ] || { [ -n "$OLD_HASH" ] && [ "$OLD_HASH" != "unknown" ] && [ -n "$CUR_HASH" ] && [ "$CUR_HASH" != "$OLD_HASH" ]; }; then
      break
    fi
  fi
  sleep 0.5 2>/dev/null || sleep 1
done

sleep 1

if [ ! -f "$ASAR_PATH" ]; then
  write_i18n_log "$BASE_DIR" "ASAR missing after update wait: $ASAR_PATH"
  exit 1
fi

if [ "$(get_asar_patch_status "$BASE_DIR" "$ASAR_PATH")" != "patched" ]; then
  if test_target_running "$PROCESS_NAME"; then
    write_i18n_log "$BASE_DIR" "New unpatched Antigravity running during repatch; waiting quietly after notification."
    show_i18n_toast "$BASE_DIR"
    while test_target_running "$PROCESS_NAME"; do
      sleep 2
    done
  fi
  if [ "$(get_asar_patch_status "$BASE_DIR" "$ASAR_PATH")" != "patched" ]; then
    patch_asar_and_sign "$BASE_DIR" "$ASAR_PATH"
  fi
fi

if [ "$RELAUNCH" = "1" ] && [ "$SKIP_RELAUNCH" -eq 0 ]; then
  if ! test_target_running "$PROCESS_NAME"; then
    LAUNCH_TARGET="$(derive_app_from_asar "$ASAR_PATH")"
    if [ -z "$LAUNCH_TARGET" ] && [ -n "$EXE_PATH" ]; then
      LAUNCH_TARGET="$(derive_app_from_exe "$EXE_PATH")"
    fi
    if [ -n "$LAUNCH_TARGET" ] && [ -d "$LAUNCH_TARGET" ] && command -v open >/dev/null 2>&1; then
      write_i18n_log "$BASE_DIR" "Relaunching patched Antigravity bundle: $LAUNCH_TARGET"
      open -a "$LAUNCH_TARGET" >/dev/null 2>&1 || true
    fi
  fi
fi
