#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: scripts/git-start.sh <feature-name>"
  exit 1
fi

name="$1"
branch="codex/${name}"

if git show-ref --verify --quiet "refs/heads/${branch}"; then
  echo "Branch already exists: ${branch}"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Warning: working tree is not clean."
fi

git checkout -b "${branch}"

echo "Created branch ${branch}."
