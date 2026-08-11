#!/usr/bin/env bash
set -euo pipefail

SOURCE_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-$HOME/Library/Application Support/Google/Chrome}"
DEST_USER_DATA_DIR="${CDP_PROFILE_DIR:-$HOME/.ats-cdp-profile}"
PROFILE_KEY="${CDP_SOURCE_PROFILE_KEY:-}"
PROFILE_NAME="${CDP_SOURCE_PROFILE_NAME:-}"
PROFILE_INDEX="${CDP_SOURCE_PROFILE_INDEX:-}"

LOCAL_STATE="$SOURCE_USER_DATA_DIR/Local State"
if [[ ! -f "$LOCAL_STATE" ]]; then
  echo "Local State not found: $LOCAL_STATE" >&2
  exit 1
fi

if [[ -z "$PROFILE_KEY" ]]; then
  PROFILE_KEY="$(node - <<'NODE' "$LOCAL_STATE" "$PROFILE_NAME" "$PROFILE_INDEX"
const fs = require('node:fs');
const localStatePath = process.argv[2];
const wantedName = process.argv[3] || '';
const wantedIndexRaw = process.argv[4] || '';
const wantedIndex = wantedIndexRaw ? Number(wantedIndexRaw) : NaN;

const raw = fs.readFileSync(localStatePath, 'utf8');
const data = JSON.parse(raw);
const profile = data?.profile ?? {};
const infoCache = profile?.info_cache ?? {};
const order = Array.isArray(profile?.profiles_order) && profile.profiles_order.length
  ? profile.profiles_order
  : Object.keys(infoCache);

if (!order.length) {
  process.exit(2);
}

if (wantedName) {
  const lower = wantedName.toLowerCase();
  const found = order.find((key) => String(infoCache[key]?.name || '').toLowerCase() === lower);
  if (found) {
    process.stdout.write(found);
    process.exit(0);
  }
  process.exit(3);
}

if (wantedIndexRaw) {
  if (Number.isFinite(wantedIndex) && wantedIndex > 0 && wantedIndex <= order.length) {
    process.stdout.write(order[wantedIndex - 1]);
    process.exit(0);
  }
  process.exit(4);
}

process.stdout.write(order[0]);
NODE
)" || {
    code="$?"
    if [[ "$code" == "3" ]]; then
      echo "Profile name not found: $PROFILE_NAME" >&2
      echo "Run: npm run cdp:profiles" >&2
      exit 1
    fi
    if [[ "$code" == "4" ]]; then
      echo "Profile index not found: $PROFILE_INDEX" >&2
      echo "Run: npm run cdp:profiles" >&2
      exit 1
    fi
    echo "Unable to resolve source profile from $LOCAL_STATE (code $code)" >&2
    exit 1
  }
fi

SOURCE_PROFILE_DIR="$SOURCE_USER_DATA_DIR/$PROFILE_KEY"
if [[ ! -d "$SOURCE_PROFILE_DIR" ]]; then
  echo "Source profile directory not found: $SOURCE_PROFILE_DIR" >&2
  exit 1
fi

rm -rf "$DEST_USER_DATA_DIR"
mkdir -p "$DEST_USER_DATA_DIR"

cp "$LOCAL_STATE" "$DEST_USER_DATA_DIR/Local State"
rsync -a --delete \
  --exclude='Cache' \
  --exclude='Code Cache' \
  --exclude='GPUCache' \
  --exclude='ShaderCache' \
  --exclude='GrShaderCache' \
  --exclude='DawnGraphiteCache' \
  --exclude='Service Worker/CacheStorage' \
  "$SOURCE_PROFILE_DIR/" "$DEST_USER_DATA_DIR/Default/"

echo "Seeded CDP profile"
echo "  source: $SOURCE_PROFILE_DIR"
echo "  dest:   $DEST_USER_DATA_DIR/Default"
