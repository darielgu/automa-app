#!/usr/bin/env bash
set -euo pipefail

USER_DATA_DIR="${CHROME_USER_DATA_DIR:-$HOME/Library/Application Support/Google/Chrome}"
LOCAL_STATE="$USER_DATA_DIR/Local State"

if [[ ! -f "$LOCAL_STATE" ]]; then
  echo "Local State not found: $LOCAL_STATE" >&2
  exit 1
fi

node - <<'NODE' "$LOCAL_STATE"
const fs = require('node:fs');
const localStatePath = process.argv[2];
const raw = fs.readFileSync(localStatePath, 'utf8');
const data = JSON.parse(raw);
const profile = data?.profile ?? {};
const infoCache = profile?.info_cache ?? {};
const order = Array.isArray(profile?.profiles_order) ? profile.profiles_order : Object.keys(infoCache);

if (!order.length) {
  console.log('No profiles found.');
  process.exit(0);
}

console.log('Index\tKey\tName\tUser');
order.forEach((key, idx) => {
  const entry = infoCache[key] || {};
  const name = entry.name || '';
  const user = entry.user_name || '';
  console.log(`${idx + 1}\t${key}\t${name}\t${user}`);
});
NODE
