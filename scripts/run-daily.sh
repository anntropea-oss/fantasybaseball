#!/usr/bin/env bash
set -euo pipefail

# Run a daily recommendation + snapshot capture.
# This is safe to call from cron/launchd; it appends to logs/snapshots.jsonl.
#
# Optional GitHub Pages publish:
#   FANTASY_PUBLISH_PAGES=1 scripts/run-daily.sh
#
# That regenerates docs/index.html + docs/dashboard-data.json + docs/dashboard.js,
# commits only those dashboard artifacts when they changed, and pushes the current
# branch. The Pages app polls dashboard-data.json, so open browser tabs update
# after GitHub Pages serves the new JSON.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

node cli.js recommend

if [[ "${FANTASY_PUBLISH_PAGES:-0}" == "1" ]]; then
  pages_branch="${FANTASY_PAGES_BRANCH:-main}"
  current_branch="$(git branch --show-current)"
  if [[ "$current_branch" != "$pages_branch" ]]; then
    echo "Dashboard publish refused: GitHub Pages is expected on '$pages_branch', but current branch is '$current_branch'." >&2
    echo "Switch to '$pages_branch' or set FANTASY_PAGES_BRANCH to the branch configured in GitHub Pages." >&2
    exit 1
  fi
  node cli.js dashboard --publish
  git add docs/index.html docs/dashboard-data.json docs/dashboard.js
  if git diff --cached --quiet -- docs/index.html docs/dashboard-data.json docs/dashboard.js; then
    echo "Dashboard publish: no changes to commit."
  else
    git commit -m "Publish dashboard $(date +%Y-%m-%d)"
    git push
  fi
fi
