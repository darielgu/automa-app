#!/usr/bin/env bash
set -euo pipefail

PORT="${CDP_PORT:-9222}"
USER_DATA_DIR="${CDP_USER_DATA_DIR:-${CDP_PROFILE_DIR:-$HOME/.ats-cdp-profile}}"
PROFILE_DIRECTORY="${CDP_PROFILE_DIRECTORY:-Default}"

mkdir -p "$USER_DATA_DIR"
mkdir -p "$USER_DATA_DIR/$PROFILE_DIRECTORY"

if [[ "$(uname -s)" == "Darwin" ]]; then
  CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
elif [[ "$(uname -s)" == "Linux" ]]; then
  CHROME_BIN="${CHROME_BIN:-google-chrome}"
else
  CHROME_BIN="${CHROME_BIN:-chrome}"
fi

echo "Starting Chrome with remote debugging on port $PORT"
echo "User data dir: $USER_DATA_DIR"
echo "Profile directory: $PROFILE_DIRECTORY"
echo "CDP URL: http://127.0.0.1:$PORT"

exec "$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --profile-directory="$PROFILE_DIRECTORY" \
  --no-first-run \
  --no-default-browser-check \
  about:blank
