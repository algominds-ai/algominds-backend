#!/bin/bash
# Backup first, then clean. Run from the repo root: bash exports/cleanup-main-db.sh
set -e
url=$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
pg_dump "$url" --data-only -t organization -t icp -t run -t round -t company -t person -t run_company -t evidence -t apikey -t member -t invitation -f exports/main-db-backup-$(date +%F).sql
psql "$url" -v ON_ERROR_STOP=1 -f exports/cleanup-main-db.sql
