#!/usr/bin/env bash
# Print the commit subjects between the previous tag and the given one as a
# markdown list. The GitHub release body becomes electron-updater's
# releaseNotes, which the update prompt shows under "What's New".
#
# Usage: bash scripts/release-notes.sh v0.1.18

set -euo pipefail

tag="${1:?usage: release-notes.sh <tag>}"
previous="$(git describe --tags --abbrev=0 "${tag}^" 2>/dev/null || true)"
range="${previous:+${previous}..}${tag}"

# The tag sits on the "Release vX" commit npm version makes, which says nothing
# a user cares about.
git log --no-merges --invert-grep --grep='^Release v' --pretty=format:'- %s' "$range"
echo

if [ -n "$previous" ]; then
  echo
  echo "**Full changelog**: https://github.com/robclouth/noise-canvas/compare/${previous}...${tag}"
fi
