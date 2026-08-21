#!/usr/bin/env bash
# Print the GitHub release body for a tag: a download table, the highlights, and
# a link to the full commit range. The body becomes electron-updater's
# releaseNotes, which the update prompt shows under "What's New".
#
# Usage: bash scripts/release-notes.sh v1.0.1 [artifacts-dir]
#
# Highlights come from docs/release-notes/<version>.md when that file exists,
# and otherwise from the commit subjects since the previous tag, grouped by
# gitmoji. The download table lists only the files present in artifacts-dir, so
# a platform that failed to build leaves no dead link.

set -euo pipefail

tag="${1:?usage: release-notes.sh <tag> [artifacts-dir]}"
artifacts="${2:-}"
version="${tag#v}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base="https://github.com/robclouth/noise-canvas/releases/download/${tag}"

# Glob, then the platform it is built for. Order sets the table's row order.
platforms=(
  "*-arm64.dmg|macOS, Apple Silicon"
  "*-x64.dmg|macOS, Intel"
  "*-setup.exe|Windows x64"
  "*.AppImage|Linux, AppImage"
  "*_amd64.deb|Linux, Debian and Ubuntu"
  "*.ablx|Ableton Live extension"
)

download_table() {
  [ -n "$artifacts" ] && [ -d "$artifacts" ] || return 0

  local rows=""
  for entry in "${platforms[@]}"; do
    local glob="${entry%%|*}" label="${entry#*|}" file name size
    file="$(find "$artifacts" -type f -name "$glob" | sort | head -1)"
    [ -n "$file" ] || continue
    name="$(basename "$file")"
    size="$(awk -v b="$(wc -c <"$file")" 'BEGIN { printf "%d", b / 1048576 }')"
    rows+="| **${label}** | [${name}](${base}/${name}) (${size} MB) |"$'\n'
  done
  [ -n "$rows" ] || return 0

  echo "### Downloads"
  echo
  echo "| Platform | File |"
  echo "| --- | --- |"
  printf '%s' "$rows"
  echo
  echo "The .zip and .yml files under Assets are for the in-app updater, and are not downloads."
  echo
  echo "---"
  echo
}

# Turn "✨ (scope): does a thing" into "- **scope**: does a thing", and a subject
# with no scope into a plain bullet.
group() {
  local emoji="$1" heading="$2" subjects
  subjects="$(git log --no-merges --invert-grep --grep='^Release v' \
    --pretty=format:'%s' "$range" | grep "^${emoji}" || true)"
  [ -n "$subjects" ] || return 0

  echo "### ${heading}"
  echo
  printf '%s\n' "$subjects" | sed "s/^${emoji}[[:space:]]*//" | awk '
    match($0, /^\(([^)]*)\): /) {
      scope = substr($0, RSTART + 1, RLENGTH - 4)
      print "- **" scope "**: " substr($0, RSTART + RLENGTH)
      next
    }
    { print "- " $0 }
  '
  echo
}

previous="$(git describe --tags --abbrev=0 "${tag}^" 2>/dev/null || true)"
range="${previous:+${previous}..}${tag}"

download_table

curated="${root}/docs/release-notes/${version}.md"
if [ -f "$curated" ]; then
  cat "$curated"
  echo
else
  highlights="$({
    group "✨" "New"
    group "⚡" "Faster"
    group "🐛" "Fixed"
  })"

  # A range with no gitmoji subjects groups to nothing, so list it unsorted
  # rather than publishing an empty body.
  if [ -z "$highlights" ]; then
    highlights="$(git log --no-merges --invert-grep --grep='^Release v' \
      --pretty=format:'- %s' "$range")"
  fi

  printf '%s\n\n' "$highlights"
fi

if [ -n "$previous" ]; then
  echo "**Full changelog**: https://github.com/robclouth/noise-canvas/compare/${previous}...${tag}"
fi
