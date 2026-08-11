#!/usr/bin/env bash
set -euo pipefail

cat <<'MSG'
Ashby fixture capture guide:
1) Set env: ASHBY_FIXTURE_CAPTURE=1
2) Run fresh live Ashby auto-submit sessions across many companies
3) Snapshots are stored under .playwright-mcp/ashby-fixtures/<company>/<timestamp>/
4) Build/update catalog: npm run ashby:fixtures:catalog
5) Run local replay suite: npm run ashby:fixtures:test
MSG
