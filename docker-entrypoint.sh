#!/bin/sh
set -e

# A fresh Railway Volume mounted at /workspace lands owned by root, so
# fix it up to belong to the running user before we try to write to it.
# Passwordless sudo is configured for the developer user specifically
# so this single chown can succeed without further setup.
if [ ! -w /workspace ]; then
  sudo chown "$(id -u):$(id -g)" /workspace || {
    echo "ERROR: /workspace is not writable and chown failed." >&2
    echo "Check the volume's mount permissions in your platform's dashboard." >&2
    exit 1
  }
fi

# Ensure OpenCode's session/auth dir exists in the workspace. The image
# symlinks ~/.local/share/opencode -> /workspace/.opencode so a single
# Railway Volume on /workspace persists projects + session history.
mkdir -p /workspace/.opencode

# OpenCode picks the "worktree" (project root) by walking up from cwd
# looking for a .git directory. With no .git ancestor it falls back to /
# and refuses to write there ("the default working directory (/) doesn't
# allow writing"). Init ~/dev as a git repo so opencode anchors there as
# the worktree. Skipped if a previous deploy already set this up.
#
# NOTE: ~/dev is on the image's home filesystem, NOT the Railway Volume,
# so anything written here is ephemeral. The volume stays at /workspace.
DEV_DIR="${HOME:-/home/developer}/dev"
mkdir -p "$DEV_DIR"
if [ ! -d "$DEV_DIR/.git" ]; then
  git init -q "$DEV_DIR"
  git -C "$DEV_DIR" config user.email "developer@my-opencode.local"
  git -C "$DEV_DIR" config user.name  "Developer"
fi

# Pin cwd to ~/dev — Railway can start the container from / regardless
# of the Dockerfile's WORKDIR.
cd "$DEV_DIR"

exec "$@"
