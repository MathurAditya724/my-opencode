#!/bin/bash
# Pre-release version bump for the opentower package.
#
# Craft's built-in auto-bumping runs `npm version` which can fail on
# file: deps. We bypass npm entirely by editing package.json with jq.
#
# Also bumps:
#   - coder-template/main.tf  (docker_image default tag)
#
# Craft passes the new version via CRAFT_NEW_VERSION.
set -euo pipefail

NEW_VERSION="${CRAFT_NEW_VERSION:-${2:-}}"
if [ -z "$NEW_VERSION" ]; then
  echo "error: CRAFT_NEW_VERSION not set and no positional version argument" >&2
  exit 1
fi

echo "Bumping opentower to ${NEW_VERSION}"

# 1) opentower package.json
PKG="packages/opentower/package.json"
tmp="$(mktemp)"
jq --arg v "$NEW_VERSION" '.version = $v' "$PKG" > "$tmp"
mv "$tmp" "$PKG"
name=$(jq -r '.name' "$PKG")
echo "  ✓ ${name} → ${NEW_VERSION}"

# 2) Coder template: pin docker_image default to the release tag
TF="coder-template/main.tf"
sed -i "s|ghcr.io/mathuraditya724/outpost:[^\"]*|ghcr.io/mathuraditya724/outpost:${NEW_VERSION}|" "$TF"
echo "  ✓ ${TF} → :${NEW_VERSION}"

echo "Version bump complete."
