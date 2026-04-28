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
# allow writing"). Init /workspace as a git repo so opencode anchors on
# /workspace as the worktree. Skipped if a previous deploy already set
# this up.
if [ ! -d /workspace/.git ]; then
  git init -q /workspace
  git -C /workspace config user.email "developer@my-opencode.local"
  git -C /workspace config user.name  "Developer"
fi

# Pin cwd to /workspace too — Railway can start the container from /
# regardless of the Dockerfile's WORKDIR.
cd /workspace

exec "$@"
