#!/usr/bin/env bash
# launch.sh — start the cc-spawner daemon.
#
# Since 2026-09-06 the daemon is a launchd user agent (~/Library/LaunchAgents/cc.cc-spawner.plist,
# label cc.cc-spawner, KeepAlive, RunAtLoad) so it survives reboots. This script (re)starts it via
# launchctl when the plist is present and falls back to the old nohup+pidfile path otherwise.
set -euo pipefail
cd "$(dirname "$0")"

LABEL="cc.cc-spawner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/.portal/cc-spawner.log"
mkdir -p "$HOME/.portal"

if [ -f "$PLIST" ]; then
  DOMAIN="gui/$(id -u)"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "cc-spawner restarted via launchd ($LABEL), log: $LOG"
  else
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "cc-spawner bootstrapped via launchd ($LABEL), log: $LOG"
  fi
  exit 0
fi

# ---- legacy nohup path (no plist installed) ----
# Non-interactive launches (ssh, launchd) come with a bare PATH, and the daemon
# resolves `tmux` (homebrew) and `claude` (~/.local/bin) by bare name via
# execFile — a bare PATH makes every tmux call ENOENT (bit 2026-08-17→22:
# reconcile marked a live session dead, spawns failed at newSession).
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

PIDFILE="$HOME/.portal/cc-spawner.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "cc-spawner already running (pid $(cat "$PIDFILE"))" >&2
  exit 1
fi

NODE_BIN="${CC_SPAWNER_NODE:-$(command -v node 2>/dev/null || true)}"
if [ -z "$NODE_BIN" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] && NODE_BIN="$candidate"
  done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "node >=20 not found; set CC_SPAWNER_NODE to its absolute path" >&2
  exit 1
fi

nohup "$NODE_BIN" dist/src/main.js >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
echo "cc-spawner started (pid $(cat "$PIDFILE")), log: $LOG"
