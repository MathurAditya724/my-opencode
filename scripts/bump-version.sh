#!/bin/bash
# Pre-release version bump for the opentower package.
#
# Craft's built-in auto-bumping runs `npm version` which can fail on
# file: deps. We bypass npm entirely by editing package.json with jq.
#
# This script updates:
#   1. packages/opentower/package.json - the source package
#   2. opencode-config-package.json - pins the opentower dependency version
#
# Note: opencode-config-bun.lock cannot be regenerated here because the
# new version is not yet published to npm. The lockfile must be updated
# after publish (manually or via a post-publish workflow).
#
# Craft passes the new version via CRAFT_NEW_VERSION.
set -euo pipefail

NEW_VERSION="${CRAFT_NEW_VERSION:-${2:-}}"
if [ -z "$NEW_VERSION" ]; then
  echo "error: CRAFT_NEW_VERSION not set and no positional version argument" >&2
  exit 1
fi

echo "Bumping opentower to ${NEW_VERSION}"

# 1. Update packages/opentower/package.json
PKG="packages/opentower/package.json"
tmp="$(mktemp)"
jq --arg v "$NEW_VERSION" '.version = $v' "$PKG" > "$tmp"
mv "$tmp" "$PKG"
name=$(jq -r '.name' "$PKG")
echo "  ✓ ${name} → ${NEW_VERSION}"

# 2. Update opencode-config-package.json (opentower dependency)
CONFIG_PKG="opencode-config-package.json"
tmp="$(mktemp)"
jq --arg v "$NEW_VERSION" '.dependencies.opentower = $v' "$CONFIG_PKG" > "$tmp"
mv "$tmp" "$CONFIG_PKG"
echo "  ✓ ${CONFIG_PKG} opentower dep → ${NEW_VERSION}"

echo "Version bump complete."
echo ""
echo "Note: opencode-config-bun.lock must be regenerated after publish"
echo "when the new version is available on npm."
