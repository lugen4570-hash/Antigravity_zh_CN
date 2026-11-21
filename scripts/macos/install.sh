#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BASE_DIR="$HOME/.antigravity-i18n"
APP_PATH=""
ASAR_PATH=""
PROCESS_NAME="Antigravity"
SKIP_AGENT_REGISTER=0
SKIP_PATCH=0
NO_WAIT=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
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

# shellcheck source=scripts/macos/common.sh
. "$SCRIPT_DIR/common.sh"

if [ -z "$APP_PATH" ]; then
  APP_PATH="$(resolve_app_bundle)"
fi
if [ -z "$ASAR_PATH" ]; then
  ASAR_PATH="$APP_PATH/Contents/Resources/app.asar"
fi

for sub in runtime dict patcher scripts logs backups; do
  mkdir -p "$BASE_DIR/$sub"
done

for sub in runtime dict patcher scripts; do
  if [ -d "$SOURCE_DIR/$sub" ]; then
    cp -R "$SOURCE_DIR/$sub/." "$BASE_DIR/$sub/"
  fi
done

find "$BASE_DIR/scripts" -type f -name '*.sh' -exec chmod +x {} + 2>/dev/null || true

if [ ! -f "$BASE_DIR/config.json" ] && [ -f "$SOURCE_DIR/config.default.json" ]; then
  cp "$SOURCE_DIR/config.default.json" "$BASE_DIR/config.json"
fi

if [ "$SKIP_AGENT_REGISTER" -eq 0 ]; then
  AGENTS_DIR="$HOME/Library/LaunchAgents"
  PLIST_PATH="$AGENTS_DIR/com.antigravity.i18n.selfheal.plist"
  HEAL_SCRIPT="$BASE_DIR/scripts/macos/self-heal.sh"
  mkdir -p "$AGENTS_DIR"
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.antigravity.i18n.selfheal</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HEAL_SCRIPT</string>
    <string>--base-dir</string>
    <string>$BASE_DIR</string>
    <string>--asar-path</string>
    <string>$ASAR_PATH</string>
    <string>--process-name</string>
    <string>$PROCESS_NAME</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>1800</integer>
  <key>StandardOutPath</key>
  <string>$BASE_DIR/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$BASE_DIR/logs/launchd.err.log</string>
</dict>
</plist>
EOF

  if command -v launchctl >/dev/null 2>&1; then
    UID_NUM="$(id -u)"
    launchctl bootout "gui/$UID_NUM/com.antigravity.i18n.selfheal" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "gui/$UID_NUM" "$PLIST_PATH" >/dev/null 2>&1; then
      launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
      launchctl load "$PLIST_PATH" >/dev/null 2>&1 || true
    fi
  fi
fi

if [ "$SKIP_PATCH" -eq 0 ] && [ -f "$ASAR_PATH" ]; then
  if [ ! -w "$ASAR_PATH" ] && [ ! -w "$(dirname "$ASAR_PATH")" ]; then
    echo "Warning: No write permission to $ASAR_PATH. Re-run with sudo if Antigravity.app is root-owned." >&2
  fi
  HEAL_SCRIPT="$BASE_DIR/scripts/macos/self-heal.sh"
  if [ "$NO_WAIT" -eq 1 ]; then
    /bin/bash "$HEAL_SCRIPT" --base-dir "$BASE_DIR" --asar-path "$ASAR_PATH" --process-name "$PROCESS_NAME" --no-wait
  else
    nohup /bin/bash "$HEAL_SCRIPT" --base-dir "$BASE_DIR" --asar-path "$ASAR_PATH" --process-name "$PROCESS_NAME" >/dev/null 2>&1 &
  fi
fi

echo "Deployed Antigravity i18n runtime to $BASE_DIR"
