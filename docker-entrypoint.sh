#!/bin/sh
set -e

# Ensure OpenCode's session/auth dir exists in the workspace volume on first
# boot. The image symlinks ~/.local/share/opencode -> /workspace/.opencode
# so a single Railway Volume mounted at /workspace persists both projects
# and OpenCode session history.
mkdir -p /workspace/.opencode

exec "$@"
