#!/bin/bash
# agent-fleet.sh — forwards every Claude Code hook event to the agent-fleet app.
# Installed by agent-fleet into ~/.claude/hooks/. Reads the hook JSON from stdin and
# POSTs it to the app. Silent no-op when the app is not running. Never blocks Claude.
curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- \
  http://127.0.0.1:47391/hook >/dev/null 2>&1 </dev/stdin || true
exit 0
