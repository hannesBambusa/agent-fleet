#!/bin/bash
# agent-fleet: capture the live status-line payload.
#
# Claude Code hands the status line fresh numbers on stdin — context window, 5h and 7d rate limits —
# and that payload is the only live source for them: the cache in ~/.claude.json is refreshed rarely
# and can be many hours old. This writes the payload where the app can read it, prints nothing, and
# never fails the status line.
input=$(cat)
dir="$HOME/.claude/agent-fleet/status"
mkdir -p "$dir" 2>/dev/null || exit 0
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$sid" ] || sid=$(printf '%s' "$input" | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p')
[ -n "$sid" ] || sid=unknown
printf '%s' "$input" > "$dir/.$sid.tmp" 2>/dev/null && mv -f "$dir/.$sid.tmp" "$dir/$sid.json" 2>/dev/null
# the status line renders several times a second, so sweep only now and then
if [ $((RANDOM % 200)) -eq 0 ]; then
  find "$dir" -name '*.json' -mtime +1 -delete 2>/dev/null
fi
exit 0
