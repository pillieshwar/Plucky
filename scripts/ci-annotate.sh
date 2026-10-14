#!/usr/bin/env bash
# Run a command; if it fails, surface its error lines as GitHub Actions
# annotations so they are visible from the run summary and the API, not only
# in the raw log.
set -uo pipefail

log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ]; then
  grep -E '(^|[^a-z])(error|warning)(\[[A-Z0-9]+\])?:|error TS[0-9]+|FAILED|panicked at' "$log" \
    | grep -v 'warning: build failed, waiting' \
    | head -n 40 \
    | while IFS= read -r line; do
        # Annotation text must be one line; keep it short.
        echo "::error title=$1 failed::${line:0:900}"
      done
fi
rm -f "$log"
exit "$status"
