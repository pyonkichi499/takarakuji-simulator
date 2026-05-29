#!/usr/bin/env bash
#
# Collect today's Claude Code token usage via ccusage, merge it into a cumulative
# store, and push the result to a GitHub repo so it can be reviewed later from anywhere.
#
# Designed to run on the machine where Claude Code actually runs (your local Mac),
# because ccusage reads local logs under ~/.claude/projects.
#
# Configure via environment variables (or edit the defaults below):
#   USAGE_REPO_DIR : path to a local clone of the GitHub repo that stores the data
#   USAGE_BRANCH   : branch to push to (default: main)
#
set -euo pipefail

# --- config -----------------------------------------------------------------
USAGE_REPO_DIR="${USAGE_REPO_DIR:-$HOME/claude-usage-log}"
USAGE_BRANCH="${USAGE_BRANCH:-main}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Make Homebrew node/npx visible to launchd (which has a minimal PATH).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# --- sanity checks ----------------------------------------------------------
if ! command -v npx >/dev/null 2>&1; then
  echo "error: npx not found on PATH ($PATH)" >&2
  exit 1
fi
if [ ! -d "$USAGE_REPO_DIR/.git" ]; then
  echo "error: $USAGE_REPO_DIR is not a git repo. Clone your data repo there first." >&2
  exit 1
fi

cd "$USAGE_REPO_DIR"

# Avoid drifting from remote.
git pull --quiet --rebase origin "$USAGE_BRANCH" || true

mkdir -p data
TODAY="$(date +%Y-%m-%d)"

# Full daily history as JSON (covers everything still in local logs).
FRESH="$(mktemp)"
trap 'rm -f "$FRESH"' EXIT
npx -y ccusage@latest daily --json >"$FRESH"

# Keep a raw point-in-time snapshot (handy for audits) ...
cp "$FRESH" "data/snapshot-$TODAY.json"
# ... and merge into the cumulative store + CSV.
node "$SCRIPT_DIR/merge.mjs" "$FRESH" "data/usage.json"

# --- commit & push (with simple retry) --------------------------------------
git add -A
if git diff --cached --quiet; then
  echo "no changes to commit"
  exit 0
fi
git commit -m "chore: ccusage daily usage snapshot ($TODAY)"

n=0
until [ "$n" -ge 4 ]; do
  if git push origin "HEAD:$USAGE_BRANCH"; then
    echo "pushed."
    exit 0
  fi
  n=$((n + 1))
  sleep $((2 ** n))
done
echo "error: push failed after retries" >&2
exit 1
