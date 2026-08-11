#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-auto-submit}"
CONFIG_PATH="${2:-examples/config.alex-rivera.json}"
PROFILE_PATH="${3:-examples/profile.alex-rivera.json}"
JOBS_PATH="${4:-examples/jobs.lever.vetted.txt}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-2}"
MAX_RETRIES_PER_JOB="${MAX_RETRIES_PER_JOB:-1}"
GOAL_CONFIRMED="${GOAL_CONFIRMED:-1}"
IDLE_DELAY_SECONDS="${IDLE_DELAY_SECONDS:-2}"
MAX_IDLE_CYCLES="${MAX_IDLE_CYCLES:-1}"
STOP_AFTER_CONSECUTIVE_FAILURES="${STOP_AFTER_CONSECUTIVE_FAILURES:-3}"
SESSION_OUTPUT_DIR="${SESSION_OUTPUT_DIR:-output/sessions/lever-headed-$(date +%Y%m%d-%H%M%S)}"

CDP_PORT="${CDP_PORT:-9223}"
CDP_USER_DATA_DIR="${CDP_USER_DATA_DIR:-$HOME/.ats-cdp-profile}"
CDP_PROFILE_DIRECTORY="${CDP_PROFILE_DIRECTORY:-Default}"
CDP_URL="${CDP_URL:-http://127.0.0.1:${CDP_PORT}}"

cleanup() {
  if [[ -n "${CHROME_PID:-}" ]]; then
    kill "${CHROME_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "${EXTERNAL_CDP:-}" ]]; then
  CDP_PORT="${CDP_PORT}" \
  CDP_USER_DATA_DIR="${CDP_USER_DATA_DIR}" \
  CDP_PROFILE_DIRECTORY="${CDP_PROFILE_DIRECTORY}" \
  nohup ./scripts/start-chrome-cdp.sh > /tmp/lever-cdp.log 2>&1 &
  CHROME_PID="$!"
  sleep 3
fi

set -a
[ -f .env ] && source .env
set +a

export CDP_URL
export HEADLESS=0

echo "Running Lever provider loop in headed mode with persisted profile"
echo "CDP_URL=${CDP_URL}"
echo "MODE=${MODE}"
echo "CONFIG=${CONFIG_PATH}"
echo "PROFILE=${PROFILE_PATH}"
echo "JOBS=${JOBS_PATH}"
echo "SESSION_OUTPUT_DIR=${SESSION_OUTPUT_DIR}"

npm run loop -- \
  --config "${CONFIG_PATH}" \
  --profile "${PROFILE_PATH}" \
  --provider lever \
  --jobs-file "${JOBS_PATH}" \
  --mode "${MODE}" \
  --goal-confirmed-apps "${GOAL_CONFIRMED}" \
  --max-attempts "${MAX_ATTEMPTS}" \
  --max-retries-per-job "${MAX_RETRIES_PER_JOB}" \
  --idle-delay-seconds "${IDLE_DELAY_SECONDS}" \
  --max-idle-cycles "${MAX_IDLE_CYCLES}" \
  --stop-after-consecutive-failures "${STOP_AFTER_CONSECUTIVE_FAILURES}" \
  --session-output-dir "${SESSION_OUTPUT_DIR}"
