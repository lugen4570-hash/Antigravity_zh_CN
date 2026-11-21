#!/usr/bin/env bash

write_i18n_log() {
  local base_dir="$1"
  local message="$2"
  local log_dir="$base_dir/logs"
  mkdir -p "$log_dir" 2>/dev/null || return 0
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo 'unknown-time')"
  printf '[%s] %s\n' "$ts" "$message" >> "$log_dir/i18n.log" 2>/dev/null || true
}

resolve_app_bundle() {
  if [ -n "${ANTIGRAVITY_APP_PATH:-}" ]; then
    printf '%s\n' "$ANTIGRAVITY_APP_PATH"
    return 0
  fi
  if [ -d "/Applications/Antigravity.app" ]; then
    printf '%s\n' "/Applications/Antigravity.app"
    return 0
  fi
  if [ -d "$HOME/Applications/Antigravity.app" ]; then
    printf '%s\n' "$HOME/Applications/Antigravity.app"
    return 0
  fi
  printf '%s\n' "/Applications/Antigravity.app"
}

derive_app_from_asar() {
  local asar_path="$1"
  case "$asar_path" in
    */Contents/Resources/app.asar)
      printf '%s\n' "${asar_path%/Contents/Resources/app.asar}"
      ;;
    *)
      printf '\n'
      ;;
  esac
}

derive_app_from_exe() {
  local exe_path="$1"
  case "$exe_path" in
    *.app/Contents/MacOS/*)
      printf '%s\n' "${exe_path%%/Contents/MacOS/*}"
      ;;
    *.app)
      printf '%s\n' "$exe_path"
      ;;
    *)
      printf '\n'
      ;;
  esac
}

get_file_sha256() {
  local file_path="$1"
  [ -f "$file_path" ] || return 0
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
  else
    node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$file_path"
  fi
}

enter_i18n_lock() {
  local base_dir="$1"
  local timeout_secs="${2:-0}"
  local lock_dir="$base_dir/.heal.lock"
  mkdir -p "$base_dir" 2>/dev/null || true

  local waited=0
  local max_ticks=$((timeout_secs * 3))
  while true; do
    if mkdir "$lock_dir" 2>/dev/null; then
      printf '%s\n' "$$" > "$lock_dir/pid" 2>/dev/null || true
      return 0
    fi

    if [ -f "$lock_dir/pid" ]; then
      local owner_pid
      owner_pid="$(tr -d '[:space:]' < "$lock_dir/pid" 2>/dev/null || true)"
      if [ -n "$owner_pid" ]; then
        if ! kill -0 "$owner_pid" 2>/dev/null; then
          rm -rf "$lock_dir" 2>/dev/null || true
          continue
        fi
      fi
    fi

    if [ "$timeout_secs" -le 0 ] || [ "$waited" -ge "$max_ticks" ]; then
      return 1
    fi
    sleep 0.35 2>/dev/null || sleep 1
    waited=$((waited + 1))
  done
}

exit_i18n_lock() {
  local base_dir="$1"
  local lock_dir="$base_dir/.heal.lock"
  if [ -d "$lock_dir" ]; then
    local owner_pid=""
    if [ -f "$lock_dir/pid" ]; then
      owner_pid="$(tr -d '[:space:]' < "$lock_dir/pid" 2>/dev/null || true)"
    fi
    if [ -z "$owner_pid" ] || [ "$owner_pid" = "$$" ]; then
      rm -rf "$lock_dir" 2>/dev/null || true
    fi
  fi
}

test_target_running() {
  local process_name="${1:-Antigravity}"
  if [ -n "${AGY_TEST_PID_FILE:-}" ]; then
    if [ -f "$AGY_TEST_PID_FILE" ]; then
      local test_pid
      test_pid="$(tr -d '[:space:]' < "$AGY_TEST_PID_FILE" 2>/dev/null || true)"
      if [ -n "$test_pid" ] && kill -0 "$test_pid" 2>/dev/null; then
        return 0
      fi
    fi
    return 1
  fi
  if [ -z "$process_name" ]; then
    return 1
  fi
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -x "$process_name" >/dev/null 2>&1 && return 0
  fi
  return 1
}

get_asar_patch_status() {
  local base_dir="$1"
  local asar_path="$2"
  local patcher="$base_dir/patcher/asar-patch.mjs"
  if [ ! -f "$patcher" ] || [ ! -f "$asar_path" ]; then
    printf 'missing\n'
    return 0
  fi
  local raw
  raw="$(node "$patcher" status "$asar_path" 2>/dev/null || true)"
  if [ -z "$raw" ]; then
    printf 'error\n'
    return 0
  fi
  node -e "try{const j=JSON.parse(process.argv[1]);process.stdout.write(j.status||'error')}catch{process.stdout.write('error')}" "$raw"
  printf '\n'
}

read_bundle_version() {
  local plist_path="$1"
  if [ ! -f "$plist_path" ]; then
    printf 'orig\n'
    return 0
  fi
  if [ -x /usr/libexec/PlistBuddy ]; then
    local v
    v="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist_path" 2>/dev/null || true)"
    if [ -n "$v" ]; then
      printf '%s\n' "$v"
      return 0
    fi
  fi
  node -e "
    const fs = require('fs');
    const txt = fs.readFileSync(process.argv[1], 'utf8');
    const m = txt.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    process.stdout.write(m ? m[1].trim() : 'orig');
  " "$plist_path" 2>/dev/null || printf 'orig'
  printf '\n'
}

patch_asar_and_sign() {
  local base_dir="$1"
  local asar_path="$2"
  local patcher="$base_dir/patcher/asar-patch.mjs"
  local scanner="$base_dir/scripts/scan-new-strings.mjs"
  local plist_helper="$base_dir/scripts/macos/update-plist-integrity.mjs"

  local res_dir
  res_dir="$(dirname "$asar_path")"
  local app_path
  app_path="$(derive_app_from_asar "$asar_path")"
  local plist_path=""
  local ver="orig"
  if [ -n "$app_path" ] && [ -f "$app_path/Contents/Info.plist" ]; then
    plist_path="$app_path/Contents/Info.plist"
    ver="$(read_bundle_version "$plist_path")"
  fi

  local backup_path="$base_dir/backups/app.asar.bak.$ver"
  local patch_out
  if ! patch_out="$(node "$patcher" patch "$asar_path" --backup "$backup_path" 2>&1)"; then
    write_i18n_log "$base_dir" "asar-patch failed: $patch_out"
    printf '%s\n' "$patch_out" >&2
    return 1
  fi
  write_i18n_log "$base_dir" "Patched ASAR ($asar_path): $patch_out"

  if [ -n "$plist_path" ] && [ -f "$plist_helper" ]; then
    if command -v plutil >/dev/null 2>&1; then
      plutil -convert xml1 "$plist_path" >/dev/null 2>&1 || true
    fi
    local plist_backup="$base_dir/backups/Info.plist.bak.$ver"
    local plist_out
    plist_out="$(node "$plist_helper" "$plist_path" "$asar_path" --backup "$plist_backup" 2>&1 || true)"
    write_i18n_log "$base_dir" "Plist integrity check: $plist_out"
  fi

  if [ -n "$app_path" ] && [ -d "$app_path" ]; then
    if command -v xattr >/dev/null 2>&1; then
      xattr -cr "$app_path" >/dev/null 2>&1 || true
    fi
    if command -v codesign >/dev/null 2>&1; then
      local sign_out
      if ! sign_out="$(codesign --force --deep --sign - "$app_path" 2>&1)"; then
        write_i18n_log "$base_dir" "codesign warning ($app_path): $sign_out"
      else
        write_i18n_log "$base_dir" "Ad-hoc signed app bundle: $app_path"
      fi
    fi
  fi

  if [ -f "$scanner" ]; then
    node "$scanner" "$base_dir" "$res_dir" >/dev/null 2>&1 || true
  fi
}

show_i18n_toast() {
  local base_dir="$1"
  local title="${2:-Antigravity 汉化助手}"
  local body="${3:-Antigravity 已更新，完全退出 (Cmd+Q) 并重新打开后将自动恢复中文界面}"
  local cfg_path="$base_dir/config.json"
  if [ -f "$cfg_path" ]; then
    local toast_enabled
    toast_enabled="$(node -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(c.toastOnLock===false?'false':'true')}catch{process.stdout.write('true')}" "$cfg_path" 2>/dev/null || echo 'true')"
    if [ "$toast_enabled" = "false" ]; then
      return 0
    fi
  fi

  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$body\" with title \"$title\"" >/dev/null 2>&1 || true
  else
    write_i18n_log "$base_dir" "Toast fallback ($title): $body"
  fi
}
