#!/usr/bin/env bash
# stop.sh — stop the cc-spawner daemon (spawned bots keep running).
# With the launchd unit installed this unloads it (so KeepAlive doesn't respawn it);
# ./launch.sh bootstraps it again.
set -euo pipefail

LABEL="cc.cc-spawner"
DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL"
  echo "cc-spawner unloaded from launchd ($LABEL); ./launch.sh to bring it back"
  exit 0
fi

PIDFILE="$HOME/.portal/cc-spawner.pid"
if [ ! -f "$PIDFILE" ]; then
  echo "no pidfile at $PIDFILE — not running?" >&2
  exit 1
fi
PID="$(cat "$PIDFILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID"
  echo "sent SIGTERM to cc-spawner (pid $PID)"
else
  echo "stale pidfile (pid $PID not running)" >&2
fi
rm -f "$PIDFILE"
