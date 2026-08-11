#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: ./scripts/lever-headed-single.sh <lever-apply-url> [mode] [config] [profile]" >&2
  exit 1
fi

TARGET_URL="$1"
MODE="${2:-auto-submit}"
CONFIG_PATH="${3:-examples/config.alex-rivera.cdp.live.json}"
PROFILE_PATH="${4:-examples/profile.alex-rivera.json}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-2}"
MAX_RETRIES_PER_JOB="${MAX_RETRIES_PER_JOB:-1}"
GOAL_CONFIRMED="${GOAL_CONFIRMED:-1}"
IDLE_DELAY_SECONDS="${IDLE_DELAY_SECONDS:-2}"
MAX_IDLE_CYCLES="${MAX_IDLE_CYCLES:-1}"
STOP_AFTER_CONSECUTIVE_FAILURES="${STOP_AFTER_CONSECUTIVE_FAILURES:-1}"
SESSION_OUTPUT_DIR="${SESSION_OUTPUT_DIR:-output/sessions/lever-headed-single-$(date +%Y%m%d-%H%M%S)}"
TEMP_JOBS_FILE="$(mktemp /tmp/lever-single-job.XXXXXX)"

CDP_PORT="${CDP_PORT:-9222}"
CDP_USER_DATA_DIR="${CDP_USER_DATA_DIR:-$HOME/.ats-cdp-profile}"
CDP_PROFILE_DIRECTORY="${CDP_PROFILE_DIRECTORY:-Default}"
CDP_URL="${CDP_URL:-http://127.0.0.1:${CDP_PORT}}"

cleanup() {
  rm -f "${TEMP_JOBS_FILE}" >/dev/null 2>&1 || true
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

printf '%s\n' "${TARGET_URL}" > "${TEMP_JOBS_FILE}"

echo "Running single Lever job in headed mode with persisted profile"
echo "CDP_URL=${CDP_URL}"
echo "URL=${TARGET_URL}"
echo "MODE=${MODE}"
echo "CONFIG=${CONFIG_PATH}"
echo "PROFILE=${PROFILE_PATH}"
echo "TEMP_JOBS_FILE=${TEMP_JOBS_FILE}"
echo "SESSION_OUTPUT_DIR=${SESSION_OUTPUT_DIR}"

npm run loop -- \
  --config "${CONFIG_PATH}" \
  --profile "${PROFILE_PATH}" \
  --provider lever \
  --jobs-file "${TEMP_JOBS_FILE}" \
  --mode "${MODE}" \
  --goal-confirmed-apps "${GOAL_CONFIRMED}" \
  --max-attempts "${MAX_ATTEMPTS}" \
  --max-retries-per-job "${MAX_RETRIES_PER_JOB}" \
  --idle-delay-seconds "${IDLE_DELAY_SECONDS}" \
  --max-idle-cycles "${MAX_IDLE_CYCLES}" \
  --stop-after-consecutive-failures "${STOP_AFTER_CONSECUTIVE_FAILURES}" \
  --session-output-dir "${SESSION_OUTPUT_DIR}"
