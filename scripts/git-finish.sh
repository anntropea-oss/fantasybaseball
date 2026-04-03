#!/usr/bin/env bash
set -euo pipefail

current_branch="$(git rev-parse --abbrev-ref HEAD)"

if [ "${current_branch}" = "main" ]; then
  echo "You are already on main. Switch to a feature branch first."
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean. Commit or stash your changes first."
  exit 1
fi

git checkout main
git pull
git merge "${current_branch}"
git push

echo "Merged ${current_branch} into main and pushed."
