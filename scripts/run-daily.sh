#!/usr/bin/env bash
set -euo pipefail

# Run a daily recommendation + snapshot capture.
# This is safe to call from cron/launchd; it appends to logs/snapshots.jsonl.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

node cli.js recommend

