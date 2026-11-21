#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/macos/common.sh
. "$SCRIPT_DIR/common.sh"

BASE_DIR="$HOME/.antigravity-i18n"
ASAR_PATH=""
PROCESS_NAME="Antigravity"
SKIP_AGENT_REMOVE=0
REMOVE_DATA=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-dir) BASE_DIR="$2"; shift 2 ;;
    --asar-path) ASAR_PATH="$2"; shift 2 ;;
    --process-name) PROCESS_NAME="$2"; shift 2 ;;
    --skip-agent-remove) SKIP_AGENT_REMOVE=1; shift ;;
    --remove-data) REMOVE_DATA=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ASAR_PATH" ]; then
  APP_PATH="$(resolve_app_bundle)"
  ASAR_PATH="$APP_PATH/Contents/Resources/app.asar"
fi

if [ "$SKIP_AGENT_REMOVE" -eq 0 ]; then
  PLIST_PATH="$HOME/Library/LaunchAgents/com.antigravity.i18n.selfheal.plist"
  if command -v launchctl >/dev/null 2>&1 && [ -f "$PLIST_PATH" ]; then
    UID_NUM="$(id -u)"
    launchctl bootout "gui/$UID_NUM/com.antigravity.i18n.selfheal" >/dev/null 2>&1 || true
    launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  fi
  rm -f "$PLIST_PATH"
fi

PATCHER="$BASE_DIR/patcher/asar-patch.mjs"
if [ -f "$ASAR_PATH" ] && [ -f "$PATCHER" ]; then
  if test_target_running "$PROCESS_NAME"; then
    echo "Antigravity is currently running. Quit Antigravity (Cmd+Q) and re-run uninstall.sh." >&2
    exit 1
  fi
  node "$PATCHER" unpatch "$ASAR_PATH" >/dev/null

  APP_PATH="$(derive_app_from_asar "$ASAR_PATH")"
  if [ -n "$APP_PATH" ] && [ -f "$APP_PATH/Contents/Info.plist" ]; then
    VER="$(read_bundle_version "$APP_PATH/Contents/Info.plist")"
    PLIST_BAK="$BASE_DIR/backups/Info.plist.bak.$VER"
    if [ -f "$PLIST_BAK" ]; then
      cp "$PLIST_BAK" "$APP_PATH/Contents/Info.plist"
    elif [ -f "$BASE_DIR/scripts/macos/update-plist-integrity.mjs" ]; then
      node "$BASE_DIR/scripts/macos/update-plist-integrity.mjs" "$APP_PATH/Contents/Info.plist" "$ASAR_PATH" >/dev/null || true
    fi
    if command -v codesign >/dev/null 2>&1; then
      codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 || true
    fi
  fi
fi

if [ "$REMOVE_DATA" -eq 1 ] && [ -d "$BASE_DIR" ]; then
  rm -rf "$BASE_DIR"
fi

echo "Uninstalled Antigravity i18n cleanly."
